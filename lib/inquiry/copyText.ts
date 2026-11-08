/** Called directly from a tap. Keeps iOS selection/focus when using the fallback. */
export async function copyInquiryText(text:string):Promise<void>{
  if(navigator.clipboard?.writeText){
    try{await navigator.clipboard.writeText(text);return;}catch{/* Older embedded Safari falls back below. */}
  }
  const active=document.activeElement as HTMLElement|null;
  const selection=document.getSelection();
  const ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[];
  const field=document.createElement('textarea');
  field.value=text;field.readOnly=true;field.style.cssText='position:fixed;top:0;left:0;opacity:0;font-size:16px;';
  document.body.appendChild(field);
  try{
    field.focus({preventScroll:true});field.select();field.setSelectionRange(0,text.length);
    if(!document.execCommand('copy'))throw Error('COPY_FAILED');
  }finally{
    field.remove();active?.focus({preventScroll:true});
    if(selection){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}
  }
}

/** Start ClipboardItem within the tap, before awaiting server validation (iOS Safari). */
export async function copyValidatedInquiryText(text:string,validate:()=>Promise<void>):Promise<void>{
  if(typeof ClipboardItem!=="undefined"&&navigator.clipboard?.write){
    const verified=validate().then(()=>new Blob([text],{type:"text/plain"}));
    // Observe rejection even if the browser rejects the clipboard call first.
    void verified.catch(()=>{});
    await navigator.clipboard.write([new ClipboardItem({"text/plain":verified})]);
    return;
  }
  await validate();
  await copyInquiryText(text);
}
