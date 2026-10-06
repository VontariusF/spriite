import fs from 'node:fs'
import { framePixels } from '../src/sprite/frames.ts'

const G='#b5ff78', DIM='#669149', BG='#080d0b', INK='#ecf3ee', MUTED='#8b9c92'
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;')
const text=(x,y,s,size=22,color=G,family='DejaVu Sans Mono')=>`<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" fill="${color}">${esc(s)}</text>`
function sprite(name,x=24,y=72){
  const p=framePixels(name,1); let s=''
  for(let yy=0;yy<64;yy++)for(let xx=0;xx<64;){
    const v=p[yy*64+xx],start=xx
    while(xx<64&&p[yy*64+xx]===v)xx++
    if(!v)continue
    s+=`<rect x="${x+start}" y="${y+yy}" width="${xx-start}" height="1" fill="${G}" opacity="${v/15}"/>`
  }
  return s
}
function bar(accepted,pending=0){
  let s=`<rect x="112" y="228" width="256" height="2" fill="${DIM}" opacity="0.4"/>`
  s+=`<rect x="112" y="210" width="${Math.round(accepted*256)}" height="20" fill="${G}"/>`
  for(let x=Math.round(accepted*256);x<Math.round((accepted+pending)*256);x+=2)s+=`<rect x="${112+x}" y="216" width="1" height="8" fill="${DIM}"/>`
  return s
}
function screen(kind){
  let s=text(24,38,'SPRIITE',22,DIM)
  if(kind==='speak')return s+sprite('idle')+text(112,108,'Say what to build.')+text(112,188,'00:06 / 00:30',20,DIM)+text(24,272,'Tap again to finish',20,DIM)
  if(kind==='plan')return s+sprite('plan_a',24,52)+text(112,86,'Plan | 3 milestones')+`<rect x="24" y="126" width="528" height="38" fill="none" stroke="${G}"/>`+text(36,154,'Settings 20 | Cursor',21)+text(36,197,'Theme 40 | Factory',21)+text(36,240,'Checks + PR 40 | Cursor',21)
  const accepted=kind==='accepted'
  s+=sprite(accepted?'accept_settle':'check_a')
  const lines=accepted?['The review passed.','This step is verified.']:['The worker pushed a branch.','Factory is reviewing','the diff now.']
  lines.forEach((l,i)=>s+=text(112,78+32*i,l,22))
  s+=text(112,195,accepted?'60% verified':'40% verified | in review',20,DIM)
  s+=bar(accepted?0.6:0.4,accepted?0:0.2)+text(24,272,accepted?'Explain    Talk':'Talk    Pause',22)
  return s
}
function card(x,y,idx,title,kind,caption){
  return `<g transform="translate(${x} ${y})">${text(0,0,idx,18,DIM,'DejaVu Sans')}${text(48,0,title,24,INK,'DejaVu Sans')}<rect x="0" y="28" width="700" height="374" rx="18" fill="#0c1510" stroke="#263b2b"/><g transform="translate(16 47) scale(1.16)">${screen(kind)}</g>${text(0,440,caption,20,MUTED,'DejaVu Sans')}</g>`
}
const board=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1220" viewBox="0 0 1600 1220"><rect width="1600" height="1220" fill="${BG}"/>${text(72,66,'A factory you can glance at.',42,INK,'DejaVu Sans')}${text(72,108,'Speak. Plan. Review. Keep building.',23,MUTED,'DejaVu Sans')}${card(72,180,'01','Say the goal','speak','A tap starts speech. Spriite listens.')}${card(828,180,'02','Review the milestones','plan','One mission, split across your worker sessions.')}${card(72,722,'03','Check each result','review','Submitted work stays pending while Factory reviews.')}${card(828,722,'04','Count accepted work','accepted','The bar advances only after a review passes.')}<text x="72" y="1196" font-family="DejaVu Sans" font-size="17" fill="${MUTED}">HUD mockups · 576 × 288 layout · Illustrative mission · Optical appearance varies by device</text></svg>`
fs.writeFileSync(new URL('./assets/spriite-hud.svg',import.meta.url),board)

const diagram=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="650" viewBox="0 0 1600 650"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="${DIM}"/></marker></defs><rect width="1600" height="650" fill="${BG}"/>${text(72,70,'Your accounts. One coordinated build.',40,INK,'DejaVu Sans')}${text(72,115,'Factory plans and reviews. Factory and Cursor sessions do the work.',23,MUTED,'DejaVu Sans')}<g stroke="#334e3b" stroke-width="2" fill="none" marker-end="url(#arrow)"><path d="M460 324H604"/><path d="M964 305H1060V238H1132"/><path d="M964 349H1060V415H1132"/><path d="M1300 498V554H784V436"/><path d="M1450 312V344H1558V554H1300"/></g><g>${panel(72,218,388,218,'SPRIITE','Your goal + decisions',['Glasses / ring / phone'])}${panel(604,218,360,218,'FACTORY LEAD','Plan + review',['Milestones • verdicts • fixes'])}${panel(1132,184,396,128,'FACTORY SESSIONS','Build on a Droid Computer',[])}${panel(1132,370,396,128,'CURSOR CLOUD AGENTS','Build in cloud workspaces',[])}</g>${text(850,580,'Branches + results return for review',20,MUTED,'DejaVu Sans')}</svg>`
function panel(x,y,w,h,label,title,details){return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#0c1510" stroke="#263b2b"/>${text(x+26,y+36,label,18,G,'DejaVu Sans')}${text(x+26,y+78,title,22,INK,'DejaVu Sans')}${details.map((d,i)=>text(x+26,y+120+i*30,d,18,MUTED,'DejaVu Sans')).join('')}`}
fs.writeFileSync(new URL('./assets/spriite-workers.svg',import.meta.url),diagram)
console.log('Rendered HUD and worker graphics from source pixel frames.')
