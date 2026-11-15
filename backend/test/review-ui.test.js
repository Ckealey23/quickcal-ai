import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
const root = path.resolve(import.meta.dirname, "../..");
const chrome = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(file => file && existsSync(file));
const url = file => pathToFileURL(file).href;
const page = `<!doctype html><meta charset="utf-8"><title>Document review checks</title><pre id="result">pending</pre>
${["schedule", "items", "preview", "review-ui"].map(file => `<script src="${url(path.join(root, "shared", file + ".js"))}"></script>`).join("\n")}
<script>
(async () => {
 const check = (value, message) => { if (!value) throw new Error(message); };
 const pause = () => new Promise(resolve => setTimeout(resolve, 20));
 const host = document.createElement('div'); host.style.cssText='position:fixed;left:12px;top:40px;width:380px'; document.body.append(host);
 const shadow = host.attachShadow({mode:'open'});
 const style = document.createElement('link'); style.rel='stylesheet'; style.href=${JSON.stringify(url(path.join(root, "content/widget.css")))}; shadow.append(style);
 await new Promise(resolve => {style.onload=resolve; style.onerror=resolve;});
 const card=document.createElement('section');card.className='card';shadow.append(card);
 const bar=document.createElement('div');bar.className='bar';card.append(bar);
 const input=document.createElement('input');input.className='input';bar.append(input);
 const calls=[];let state={visible:true,uploadOpen:false,attachment:null,mode:'input',operation:null};
 const item={kind:'event',title:'Team meeting',date:'2026-11-20',startTime:'10:03',endTime:'11:03',timeZone:'America/Los_Angeles',description:'Planning',sourceContext:'Meeting Friday November 20',uncertainty:'',allDay:false};
 const rows=[{id:'a',item,decision:'pending',status:'ready'}, {id:'b',item:{...item,kind:'task',title:'Submit report',startTime:null,endTime:null},decision:'pending',status:'ready'}];
 let ui;
 const send=async (action,payload={}) => {
   calls.push({action,...payload});
   if(action==='upload-panel')state={...state,uploadOpen:payload.open};
   if(action==='attachment')state={...state,attachment:payload.file?{...payload.file,size:12}:null,review:null,mode:'input'};
   if(action==='analyze-document')state={...state,mode:'review',review:{source:'document',rows,warning:''}};
   if(action==='review-item')state={...state,review:{...state.review,rows:state.review.rows.map(row=>row.id===payload.id?{...row,item:payload.item||row.item,decision:payload.item?'pending':payload.decision}:row)}};
   if(action==='create-approved')state={...state,review:{...state.review,rows:state.review.rows.map(row=>row.decision==='approved'?{...row,status:'created'}:row)}};
   ui.update(state);return {ok:true,session:state};
 };
 ui=QuickCalReviewUI.create({bar,card,input,shadow,send,reset:()=>{},expand:()=>{}});ui.update(state);
 const find=(selector,text)=>[...shadow.querySelectorAll(selector)].find(element=>element.textContent===text);
 check(shadow.querySelectorAll('.time-trigger').length===0,'No initial time controls');
 check(bar.firstElementChild.getAttribute('aria-label')==='Upload document','Paperclip is leftmost and labeled');
 const original=input.getBoundingClientRect().top;
 bar.firstElementChild.click();await pause();await new Promise(resolve=>setTimeout(resolve,260));
 check(shadow.querySelector('.upload-panel').classList.contains('is-open'),'Panel expands');check(!shadow.querySelector('.upload-panel').inert,'Expanded upload is keyboard accessible');
 check(input.getBoundingClientRect().top===original,'Input stays anchored during expansion');
 check(getComputedStyle(shadow.querySelector('.upload-panel')).transitionDuration.includes('0.24s'),'Subtle expansion animation');
 const drop=shadow.querySelector('.document-drop');const dt=new DataTransfer();dt.items.add(new File(['Meeting Friday November 20'],'schedule.txt',{type:'text/plain'}));
 drop.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));check(drop.classList.contains('drag-over'),'Drop highlight');
 drop.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
 for(let i=0;i<40&&!state.attachment;i++)await pause();check(state.attachment?.name==='schedule.txt','Dropped file attached');
 check(shadow.querySelector('.attached-name').textContent.includes('schedule.txt'),'Filename shown');
 check(!shadow.querySelector('.review-primary').disabled,'Analyze enables with a file');
 find('button','Analyze document').click();await pause();check(calls.find(call=>call.action==='analyze-document').text==='','Empty instructions supported');
 check(shadow.querySelectorAll('.proposal').length===2,'Both proposals shown');check(shadow.querySelector('.review-create').disabled,'Unreviewed items cannot be created');
 const initialTrigger=shadow.querySelector('.time-trigger');check(initialTrigger.textContent.includes('10:03'),'Unaligned time preserved');
 initialTrigger.click();await pause();let options=[...shadow.querySelectorAll('.time-option')];
 check(options.length===288,'288 five-minute choices');check(shadow.querySelector('.time-options').scrollTop>0,'Picker scrolls near current time');
 check(shadow.querySelector('.time-current').textContent.includes('10:03'),'Unaligned current time explained');
 options.find(option=>option.textContent==='10:05 AM').click();await pause();check(!shadow.querySelector('.time-popup'),'Picker closes on selection');
 check(state.review.rows[0].item.startTime==='10:05','Selected time reaches model');
 shadow.querySelector('.time-trigger').click();await pause();check(shadow.querySelector('[aria-selected=true]').textContent==='10:05 AM','Current aligned option highlighted');
 const list=shadow.querySelector('.time-options');list.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));list.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await pause();check(state.review.rows[0].item.startTime==='10:10','Keyboard selection works');
 find('button','Approve').click();await pause();check(shadow.querySelector('.review-create').textContent.includes('1 approved event'),'Final action counts approvals');
 [...shadow.querySelectorAll('.proposal')][1].querySelectorAll('button')[2].click();await pause();
 check(state.review.rows[1].decision==='skipped','Skip decision preserved');
 shadow.querySelector('.review-create').click();await pause();check(state.review.rows[0].status==='created'&&state.review.rows[1].status==='ready','Only approved items created');
 input.value='Actually only deadlines';ui.submit(input.value);await pause();check(calls.at(-1).text==='Actually only deadlines','Main input refines attached document');
 bar.firstElementChild.click();await pause();check(!state.uploadOpen&&!!state.attachment&&!!state.review,'Collapse preserves file and review');
 bar.firstElementChild.click();await pause();
 find('button','Remove').click();await pause();check(!state.attachment&&!state.review,'Remove resets extraction context');
 const browse=shadow.querySelector('input[type=file]');check(browse.accept==='.pdf,.docx,.txt','File browser accepts supported formats');
 document.getElementById('result').textContent='REVIEW_UI_PASS';
})().catch(error=>document.getElementById('result').textContent='REVIEW_UI_FAIL '+error.stack);
</script>`;
it("supports document upload, review and keyboard time editing in real Chrome", { timeout: 30000 }, async () => {
  assert.ok(chrome, "Chrome is required for UI verification.");
  const directory = mkdtempSync(path.join(tmpdir(), "quickcal-review-ui-"));
  const file = path.join(directory, "review.html"); writeFileSync(file, page);
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--user-data-dir=" + path.join(directory, "profile"), "--dump-dom", "--allow-file-access-from-files", "--window-size=420,860", "--virtual-time-budget=8000", url(file)], { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
      child.on("error", reject); child.on("close", () => resolve({ stdout, stderr }));
    });
    assert.match(output.stdout, /<pre id="result">REVIEW_UI_PASS<\/pre>/, output.stdout + "\n" + output.stderr);
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
