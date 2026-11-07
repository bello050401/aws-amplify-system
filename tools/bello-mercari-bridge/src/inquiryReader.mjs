const ID=/^[A-Za-z0-9_-]{1,160}$/;
/** Only fixed navigation + 'もっと見る'. Customer text is never executable instruction. */
export async function readExactInquiry(page,job,{now=Date.now}={}){
  const started=now();let actions=0;
  const spend=()=>{if(now()-started>=180000)throw Error('TIME_LIMIT');if(++actions>30)throw Error('ACTION_LIMIT');};
  if(!ID.test(job.shopId??'')||!ID.test(job.inquiryId??''))throw Error('PAGE_CHANGED');
  const url=`https://mercari-shops.com/seller/shops/${job.shopId}/inquiries/${job.inquiryId}`;
  if(job.url!==url)throw Error('PAGE_CHANGED');
  page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(30000);
  spend();await page.goto(url,{waitUntil:'domcontentloaded'});
  if(new URL(page.url()).pathname.startsWith('/signin'))throw Error('AUTH_REQUIRED');
  await page.getByRole('heading',{name:'メッセージ詳細',exact:true}).waitFor({state:'visible'});
  while(await page.getByRole('button',{name:'もっと見る',exact:true}).count()){
    const before=await page.locator('p').count();
    spend();await page.getByRole('button',{name:'もっと見る',exact:true}).click();
    await page.waitForFunction(n=>document.querySelectorAll('p').length!==n||![...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='もっと見る'),before,{timeout:10000});
  }
  spend();const result=await page.evaluate(extractInquiryPage);
  if(result.url!==url||!result.complete||!result.messages.length)throw Error('INCOMPLETE_HISTORY');
  return {...result,shopId:job.shopId,inquiryId:job.inquiryId,capturedAt:new Date(now()).toISOString()};
}

/** Structure verified against actual seller message-detail pages (Nov 2026). */
export function extractInquiryPage(){
  const heading=[...document.querySelectorAll('h2')].find(e=>e.textContent?.trim()==='メッセージ内容');
  const root=heading?.parentElement?.parentElement;
  if(!root)throw Error('PAGE_CHANGED');
  const when=/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/;
  const messages=[];
  for(const p of root.querySelectorAll('p')){
    const m=p.textContent?.trim().match(when);if(!m)continue;
    let row=p.parentElement;
    for(let n=0;n<4&&row&&row!==root;n++,row=row.parentElement){
      const ps=[...row.querySelectorAll('p')];
      if(ps.length>=2&&ps.filter(x=>when.test(x.textContent?.trim()??'')).length===1){
        const before=ps.slice(0,ps.indexOf(p)).map(x=>x.textContent?.trim()??'').filter(Boolean);
        const owner=!!row.querySelector('img[alt="Seller Avatar"]');
        if(!owner&&!row.querySelector('img[alt="avatar"]'))continue;
        // Sender + body + timestamp are distinct paragraphs. Never include the reply form.
        if(before.length<2)continue;
        const body=before.slice(1).join('\n');
        if(!body)continue;
        messages.push({speaker:owner?'SELLER':'BUYER',body,sentAt:new Date(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00+09:00`).toISOString()});break;
      }
    }
  }
  const link=[...document.querySelectorAll('a[data-testid="seller-link"]')].find(a=>/\/products\/[A-Za-z0-9_-]+\/?$/.test(new URL(a.href).pathname));
  const product=link?new URL(link.href):null,here=new URL(location.href);
  if(product&&product.pathname.split('/')[3]!==here.pathname.split('/')[3])throw Error('PAGE_CHANGED');
  const expected=[...root.querySelectorAll('p')].filter(p=>when.test(p.textContent?.trim()??'')).length;
  return {url:here.origin+here.pathname.replace(/\/$/,''),complete:expected===messages.length&&![...root.querySelectorAll('button')].some(b=>b.textContent?.trim()==='もっと見る'),productId:product?.pathname.split('/').at(-1)??null,messages:messages.sort((a,b)=>a.sentAt.localeCompare(b.sentAt))};
}
