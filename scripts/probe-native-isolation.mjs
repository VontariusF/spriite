/**
 * Real, dummy-only macOS Seatbelt experiment. NOT production attestation.
 * No Droid, model, credentials, owner-file reads, or external network traffic.
 * Every target is a newly created sentinel under a private temporary root.
 */
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

if (process.platform !== 'darwin') throw new Error('macOS required')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'spriite-isolation-probe-')))
const work = join(root, 'work'), owner = join(root, 'dummy-owner')
mkdirSync(work, { mode: 0o700 }); mkdirSync(owner, { mode: 0o700 })
const sentinel = `DUMMY_ONLY_${randomUUID()}`
writeFileSync(join(owner, 'arbitrary-not-a-known-secret.txt'), sentinel, { mode: 0o600 })
writeFileSync(join(owner, 'credential.txt'), sentinel, { mode: 0o600 })
const server = createServer(socket => { socket.on('error', () => {}); socket.end('dummy') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const childScript = join(work, 'untrusted-tool.pl')
writeFileSync(childScript, `
use strict;
use IO::Socket::INET;
my $owner = ${JSON.stringify(owner)}; my $work = ${JSON.stringify(work)};
sub readable { my $path = shift; return open(my $file, '<', $path) ? 1 : 0; }
sub writable { my $path = shift; return open(my $file, '>', $path) ? 1 : 0; }
my %r = (
 workWrite => writable("$work/allowed"),
 arbitraryOwnerRead => readable("$owner/arbitrary-not-a-known-secret.txt"),
 credentialFileRead => readable("$owner/credential.txt"),
 ownerWrite => writable("$owner/forbidden"),
 inheritedCredentialReadable => length($ENV{FACTORY_API_KEY} // '') > 0,
);
symlink("$owner/credential.txt", "$work/credential-alias");
$r{symlinkEscapeRead} = readable("$work/credential-alias");
$r{grandchildCredentialReadable} = system('/bin/sh', '-c', q{exec /bin/sh -c 'test -n "$FACTORY_API_KEY"'}) == 0;
$r{grandchildOwnerRead} = system('/bin/sh', '-c', q{/bin/cat "$1" >/dev/null 2>&1}, 'probe', "$owner/credential.txt") == 0;
my $parent = getppid();
my $ps = \`/bin/ps eww -p $parent 2>/dev/null\`;
$r{parentEnvironmentReadable} = index($ps, 'FACTORY_API_KEY=') >= 0;
$r{loopbackNetworkReachable} = !!IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => ${port}, Proto => 'tcp', Timeout => 2);
print '{' . join(',', map { '"' . $_ . '":' . ($r{$_} ? 'true' : 'false') } sort keys %r) . "}\\n";
`, { mode: 0o600 })
const literal = value => JSON.stringify(value)
const profile = join(root, 'boundary.sb')
writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(deny file-read-data (require-all
 (regex #"^/")
 (require-not (subpath "/System")) (require-not (subpath "/usr"))
 (require-not (subpath "/bin")) (require-not (subpath "/sbin"))
 (require-not (subpath "/Library/Apple")) (require-not (subpath "/dev"))
 (require-not (subpath "/private/preboot")) (require-not (subpath "/private/var/db"))
 (require-not (subpath ${literal(work)}))))
(deny file-write* (require-all
 (regex #"^/")
 (require-not (subpath ${literal(work)})) (require-not (literal "/dev/null"))))
`, { mode: 0o600 })
async function run(command, args) {
let stdout = '', stderr = ''
const child = spawn(command, args, {
  cwd: work, env: { PATH: '/usr/bin:/bin', HOME: work, FACTORY_API_KEY: sentinel },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', bytes => { stdout += bytes })
child.stderr.on('data', bytes => { stderr += bytes })
const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
const { exitCode, signal } = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve({ exitCode, signal })))
clearTimeout(timer)
let result
try { result = JSON.parse(stdout) } catch {}
return { exitCode, signal, result, stderr }
}
const baseline = await run('/usr/bin/perl', [childScript])
const { exitCode, signal, result, stderr } = await run('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/perl', childScript])
// Diagnostic control: denying a complete synthetic-owner subtree shows
// inheritance, but is NOT an allowlist for the actual owner's entire home.
const diagnosticProfile = join(root, 'synthetic-owner-only.sb')
writeFileSync(diagnosticProfile, `(version 1)(allow default)
(deny network*)
(deny file-read* (subpath ${literal(owner)}))
(deny file-write* (subpath ${literal(owner)}))
`, { mode: 0o600 })
const diagnostic = await run('/usr/bin/sandbox-exec', ['-f', diagnosticProfile, '/usr/bin/perl', childScript])
await new Promise(resolve => server.close(resolve))
const containmentPassed = exitCode === 0 && result?.workWrite === true &&
  ['arbitraryOwnerRead', 'credentialFileRead', 'ownerWrite', 'symlinkEscapeRead',
    'grandchildOwnerRead', 'loopbackNetworkReachable'].every(key => result[key] === false)
const credentialIsolationPassed = containmentPassed &&
  ['inheritedCredentialReadable', 'grandchildCredentialReadable', 'parentEnvironmentReadable'].every(key => result[key] === false)
const report = {
  version: 1, method: 'real_macOS_seatbelt_nested_dummy_tools', root, exitCode, signal,
  containmentPassed, credentialIsolationPassed, productionQualified: false,
  observed: result ?? null, sandboxAvailable: !!result,
  baseline: { exitCode: baseline.exitCode, signal: baseline.signal, observed: baseline.result ?? null },
  syntheticOwnerControl: {
    scope: 'synthetic_owner_subtree_only_NOT_actual_owner_home',
    exitCode: diagnostic.exitCode, signal: diagnostic.signal, observed: diagnostic.result ?? null,
    passed: diagnostic.exitCode === 0 && diagnostic.result?.workWrite === true &&
      ['arbitraryOwnerRead', 'credentialFileRead', 'ownerWrite', 'symlinkEscapeRead',
        'grandchildOwnerRead', 'loopbackNetworkReachable'].every(key => diagnostic.result[key] === false),
  },
  // Raw output is deliberately never persisted: it could contain env material.
  diagnostic: result ? null : stderr.includes('sandbox_init') ? 'sandbox_init_refused'
    : stderr.includes('Library not loaded') ? 'runtime_library_refused'
    : stderr.includes('Operation not permitted') ? 'operation_not_permitted'
    : stderr.includes('uv_') ? 'runtime_uv_refused' : 'sandbox_or_runtime_refused',
}
writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (!containmentPassed) process.exitCode = 1
