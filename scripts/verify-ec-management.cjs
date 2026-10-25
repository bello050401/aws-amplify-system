const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const fs = require("node:fs/promises");
const root = path.resolve(__dirname, "..");
const id = "11111111-1111-4111-8111-111111111111";
let state;
function reset() {
  state = {
    role: "ADMIN",
    draft: {
      id: "draft-1",
      inventoryId: id,
      title: "Chair",
      updatedAt: "2026-10-17T00:00:00Z",
      deletedAt: null,
      images: [{ storageKey: "one.jpg" }],
      price: 12000,
    },
    item: {
      id,
      name: "Chair",
      updatedAt: "2026-10-17T00:00:00Z",
      quantity: 2,
      saleEndDate: null,
      categoryId: "sale",
    },
    mutations: [],
    writes: [],
    http: { status: "LISTED", productId: "mercari-1" },
    channel: {
      id: "base-row",
      inventoryId: id,
      externalListingId: "1234",
      updatedAt: "2026-10-17T00:00:00Z",
      status: "PAUSED",
      categoryMapping: null,
    },
    remote: {
      item_id: 1234,
      title: "Chair",
      detail: "Chair description",
      price: 12000,
      stock: 2,
      visible: 0,
      img1_origin: "https://example.test/one.jpg",
    },
    baseEnabled: true,
  };
}
const models = {
  ListingDraft: {
    listListingDraftByInventoryId: async () => ({ data: state.draft ? [state.draft] : [] }),
    get: async () => ({ data: state.draft }),
    list: async () => ({ data: state.draft ? [state.draft] : [] }),
  },
  ChannelListing: {
    list: async () => ({
      data: [
        { inventoryId: id, channel: "BASE", status: "PAUSED", externalListingId: "1234", updatedAt: "now" },
      ],
    }),
    create: async () => ({ data: state.channel }),
  },
  YahooAuctionListing: {
    list: async () => ({
      data: [{ inventoryId: id, auctionId: "yahoo-1", remoteStatus: "open", checkedAt: "now" }],
    }),
  },
  MercariBridgeHttpProductLink: {
    list: async () =>
      state.failHttp
        ? { data: [], errors: ["read failure"] }
        : {
            data: [
              {
                inventoryId: id,
                remoteProductId: "mercari-1",
                remoteStatus: "STATUS_OPENED",
                verifiedAt: "now",
              },
            ],
          },
  },
};
const gql = async ({ query, variables }) => {
  state.mutations.push({ query, variables });
  if (query.includes("ArchiveEcDraft")) {
    state.draft = { ...state.draft, ...variables.input };
    return { data: { updateListingDraft: { id: state.draft.id } } };
  }
  if(query.includes("ClaimBaseManual")){
    if(state.channel.status==="PUBLISHING"||state.channel.updatedAt!==variables.condition.updatedAt.eq)return {errors:["conflict"]};
    state.channel={...state.channel,...variables.input};
    if(state.changeSourceAfterClaim)state.draft={...state.draft,updatedAt:"changed"};
  }
  if(query.includes("FinishBaseManual")){
    if(state.channel.lastError!==variables.condition.lastError.eq)return {errors:["conflict"]};
    state.channel={...state.channel,...variables.input};
    if(typeof state.channel.categoryMapping==="string")state.channel.categoryMapping=JSON.parse(state.channel.categoryMapping);
  }
  return { data: { updateChannelListing: { id: "base-row" } } };
};
async function load(file, extra = {}) {
  const mocks = {
    "server-only": "",
    "./ecCommonOperations": 'export const commonOperationSourceHash=async()=>"source";export const commonYahooUpdateAction=async()=>({status:"BLOCKED"});',
    "./econveniListing": 'export const econveniListingAction=async(id,channel,operation,token)=>{f.state().econveniCalls??=[];f.state().econveniCalls.push({id,channel,operation,token});return{inventoryId:id,channel,operation,title:"Chair",status:token?"DONE":"READY",token:"review-owned",message:"e-conveni"}};',
    "@/lib/listing/econveni/runtimeStore": 'export const readEconveniCatalog=async()=>{if(f.state().failEconveni)throw Error("unavailable");return f.state().econveniRows??[]};',
    "@/lib/inventory/ecEligibleQuery": 'export const queryEcEligibleInventory=async()=>({items:[],totalCount:0});',
    "next/cache": "export const revalidatePath=()=>{};",
    "@/lib/amplify/requireInventoryUser":
      'export const getInventoryRole=async()=>f.state().role;export const canEditInventory=r=>r==="ADMIN"||r==="EDITOR";export const getCurrentInventoryUserEmail=async()=>"test";',
    "@/lib/amplify/dataClient":
      "export const inventoryAuthMode={};export const serverDataClient={models:f.models,graphql:f.gql};",
    "@/lib/inventory/queries":
      'export const getInventoryDetail=async()=>f.state().item;export const listCategories=async()=>[{id:"sale",name:"販売中"}];',
    "@/lib/listing/service":
      'export const getListingDraftForInventory=async()=>f.state().draft?.deletedAt?null:f.state().draft;export const getChannelListing=async(id,channel)=>channel==="MERCARI_SHOPS"?(f.state().legacyMercari??null):f.state().channel;export const saveListingDraft=async()=>{throw Error("unexpected create");};',
    "./mercariWebHttpLifecycle":
      'export const getMercariHttpListingStateAction=async()=>f.state().http;export const publishMercariHttpListingAction=async()=>f.state().publication;export const reopenMercariHttpListingAction=publishMercariHttpListingAction;export const updateMercariHttpContentAction=async()=>({status:"BLOCKED"});export const stopMercariHttpListingAction=async()=>{f.state().writes.push("stop");return{status:"STOPPED",stopConfirmed:true}};',
    "./mercariWebHttpDraftJob":
      'export const getMercariWebHttpDraftJobStatusAction=async()=>({ok:true,requestId:"job-1"});',
    "./mercariWebHttpExecuteDraft":
      'export const executeMercariHttpDraftStepAction=async()=>{f.state().writes.push("prepare");return{status:"WAIT_INTERVAL",nextEligibleAtMs:123};};',
    "./yahooAuctionPreparation":
      "export const getYahooAuctionPreparationAction=async()=>({ok:true,context:{saved:{revision:1}}});",
    "./yahooAuctionWorkflow":
      'export const getYahooWorkflowAction=async()=>({ok:true,view:{listing:{remoteStatus:"open",auctionId:"auction-1",title:"Chair",priceYen:12000,quantity:1}}});export const prepareYahooPublicationAction=async()=>({ok:false,code:"INVALID_INPUT"});export const publishYahooListingAction=async()=>({ok:false,code:"WAIT_INTERVAL",waitUntil:123});export const cancelYahooListingAction=async()=>({ok:false,code:"BIDS_OR_STATE_CHANGED"});',
    "@/lib/listing/base/manualLifecycle":
      'export const reviewBaseListing=async()=>({status:"BLOCKED",message:"test"});export const executeBaseListing=async()=>({ok:false,message:"test"});',
    "@/lib/listing/base/updateLifecycle":
      'export const reviewBaseContentUpdate=async()=>({status:"BLOCKED"});export const executeBaseContentUpdate=reviewBaseContentUpdate;',
    "../ecImage": 'export const baseImageUrl=async()=>"https://example.test/source.jpg";',
    "@/lib/base/oauth": 'export const getAccessToken=async()=>"test-token";export const isBaseConnected=async()=>true;export class BaseNotConnectedError extends Error{}',
    "@/lib/base/connectionState": "export const getBaseConnectionState=async()=>({requestWriteItems:true});",
    "@/lib/listing/mercari/csv/buildExportRows":
      'export const resolveListingImageDownloadUrl=async()=>"https://example.test/source.jpg";',
    "@/lib/http/fetchWithTimeout":
      "export const fetchWithTimeout=async()=>({ok:true,json:async()=>({item:f.state().remote})});",
    "./adapter":
      'export const readBaseProductCategories=async()=>[];export const setManualBaseCategory=async()=>{};export const createBaseProduct=async()=>{f.state().writes.push("create");return {externalProductId:"1234",visibility:"PRIVATE"}};export const addManualBaseImage=async(id,n)=>{f.state().writes.push("image:"+n);const url="https://example.test/new-"+n+".jpg";if(!f.state().failImageReadback)f.state().remote["img"+n+"_origin"]=url;return url;};export const setManualBaseVisibility=async(id,visible)=>{f.state().writes.push(visible?"publish":"stop");if(!f.state().failReadback)f.state().remote.visible=visible?1:0;};export const editManualBaseContent=async(id,content)=>{f.state().writes.push("edit");if(!f.state().failReadback)Object.assign(f.state().remote,content)};export const deleteManualBaseImage=async(id,n)=>{f.state().writes.push("delete-image:"+n);delete f.state().remote["img"+n+"_origin"]};',
    ...extra,
  };
  const result = await esbuild.build({
    entryPoints: [path.join(root, file)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "mocks",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (a) =>
            Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: "test" } : null,
          );
          build.onLoad({ filter: /.*/, namespace: "test" }, (a) => ({
            contents: "const f=globalThis.fixture;" + mocks[a.path],
            loader: "ts",
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  const sandbox = {
    require,
    module,
    exports: module.exports,
    console,
    process,
    URL,
    URLSearchParams,
    Date,
    Buffer,
    fixture: { state: () => state, models, gql },
  };
  vm.runInNewContext(result.outputFiles[0].text, sandbox, { filename: file });
  return module.exports;
}
(async () => {
  reset();
  const operations = await load("app/actions/ecListingOperations.ts");
  const review = await operations.reviewEcListingAction(id, "MERCARI_SHOPS", "ARCHIVE");
  assert.equal(review.status, "READY");
  assert.equal(state.mutations.length, 0, "preview cannot delete");
  assert.equal((await operations.executeEcListingAction(review, false)).status, "BLOCKED");
  assert.equal(state.mutations.length, 0);
  state.draft.updatedAt = "changed";
  assert.equal((await operations.executeEcListingAction(review, true)).status, "BLOCKED");
  assert.equal(state.mutations.length, 0, "stale confirmation blocked");
  reset();
  const fresh = await operations.reviewEcListingAction(id, "MERCARI_SHOPS", "ARCHIVE");
  assert.equal((await operations.executeEcListingAction(fresh, true)).status, "DONE");
  assert.equal(state.mutations.length, 1);
  assert.ok(state.mutations[0].query.includes("updateListingDraft"));
  assert.equal(state.writes.length, 0, "EC deletion cannot touch marketplaces");
  assert.ok(state.mutations[0].variables.condition.updatedAt.eq, "conditional draft update");
  const restored = await operations.reviewEcListingAction(id, "BASE", "RESTORE");
  assert.equal((await operations.executeEcListingAction(restored, true)).status, "DONE");
  assert.equal(state.draft.deletedAt, null);
  reset();
  state.role = "VIEWER";
  assert.equal((await operations.reviewEcListingAction(id, "MERCARI_SHOPS", "STOP")).status, "BLOCKED");
  assert.equal(state.writes.length, 0);
  const update = await load("lib/listing/base/updateLifecycle.ts");
  process.env.BASE_MANUAL_LISTING_ENABLED = "1";
  reset();
  state.draft.description="New description";
  state.remote.visible=1;
  state.remote.img2_origin="https://example.test/extra.jpg";
  let ur=await update.reviewBaseContentUpdate(id);
  assert.equal(ur.status,"READY");assert.equal(state.writes.length,0);
  let step=await update.executeBaseContentUpdate(id,ur.token);
  assert.equal(step.status,"WAIT");assert.deepEqual(state.writes,["edit"]);
  step=await update.executeBaseContentUpdate(id,ur.token);
  assert.equal(step.status,"WAIT");assert.deepEqual(state.writes,["edit","image:1"]);
  step=await update.executeBaseContentUpdate(id,ur.token);
  assert.equal(step.status,"DONE");assert.deepEqual(state.writes,["edit","image:1","delete-image:2"]);
  assert.equal(state.remote.visible,1,"update preserves visibility");assert.equal(state.remote.stock,2);
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"DONE");assert.equal(state.writes.length,3,"completed update cannot replay");
  reset();ur=await update.reviewBaseContentUpdate(id);
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"WAIT");
  state.failImageReadback=true;
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"BLOCKED","old image cannot confirm replacement");
  assert.equal(state.channel.status,"ERROR");
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"BLOCKED");
  assert.deepEqual(state.writes,["edit","image:1"],"unverified image write is not repeated");
  reset();ur=await update.reviewBaseContentUpdate(id);state.remote.price=999;
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"BLOCKED");assert.equal(state.writes.length,0);
  reset();ur=await update.reviewBaseContentUpdate(id);state.changeSourceAfterClaim=true;
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"BLOCKED");assert.equal(state.writes.length,0,"post-claim source changes stop writes");
  reset();state.remote.variations=[{variation_id:1}];assert.equal((await update.reviewBaseContentUpdate(id)).status,"BLOCKED");
  reset();ur=await update.reviewBaseContentUpdate(id);state.failReadback=true;
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"BLOCKED");assert.equal(state.channel.status,"ERROR");
  assert.equal((await update.executeBaseContentUpdate(id,ur.token)).status,"BLOCKED");assert.equal(state.writes.length,1,"unknown write is never repeated");
  for(const channel of ["YAHOO","MERCARI_SHOPS"]){
    for(const operation of ["PUBLISH","STOP"]){
      reset();const r=await operations.reviewEcListingAction(id,channel,operation);
      assert.equal(r.status,"READY");assert.deepEqual(JSON.parse(JSON.stringify(state.econveniCalls)),[{id,channel,operation}]);
      assert.equal((await operations.executeEcListingAction(r,true,true)).status,"DONE");
      assert.equal(state.econveniCalls.length,2);assert.equal(state.econveniCalls[1].token,"review-owned");
      assert.equal(state.writes.length,0,"No old direct-marketplace calls");
    }
  }
  reset();
  const catalog = await load("app/actions/ecListingCatalog.ts");
  let result = await catalog.getEcListingCatalogAction();
  assert.equal(result.channels.MERCARI_SHOPS[id].state, "ACTIVE");
  assert.equal(result.channels.YAHOO[id].state, "ACTIVE");
  assert.equal(result.channels.BASE[id].state, "STOPPED");
  state.failHttp = true;
  result = await catalog.getEcListingCatalogAction();
  assert.equal(result.channels.MERCARI_SHOPS, undefined, "failed read cannot masquerade as unlisted");
  assert.ok(result.errors.length);
  reset();
  process.env.BASE_MANUAL_LISTING_ENABLED = "1";
  const base = await load("lib/listing/base/manualLifecycle.ts");
  let br = await base.reviewBaseListing(id, "PUBLISH");
  assert.equal(br.status, "READY");
  assert.equal(state.writes.length, 0, "BASE review cannot publish");
  state.remote.price = 1;
  assert.equal((await base.executeBaseListing(id, "PUBLISH", br.token)).ok, false);
  assert.equal(state.writes.length, 0, "changed BASE snapshot blocked");
  reset();
  br = await base.reviewBaseListing(id, "PUBLISH");
  assert.equal((await base.executeBaseListing(id, "PUBLISH", br.token)).ok, true);
  assert.deepEqual(state.writes, ["publish"]);
  assert.equal(state.mutations.at(-1).variables.input.status, "ACTIVE");
  reset();
  br = await base.reviewBaseListing(id, "PUBLISH");
  state.failReadback = true;
  assert.equal((await base.executeBaseListing(id, "PUBLISH", br.token)).ok, false);
  assert.equal(
    state.mutations.at(-1).variables.input.status,
    "ERROR",
    "unverified publication never marked active",
  );
  reset();
  delete state.remote.img1_origin;
  br = await base.reviewBaseListing(id, "PUBLISH");
  assert.equal(br.status, "WAIT");
  assert.deepEqual(state.writes, ["image:1"]);
  assert.equal(state.mutations.at(-1).variables.input.status, "PAUSED", "image preparation remains private");
  reset();
  state.item.quantity = 0;
  assert.equal((await base.reviewBaseListing(id, "PUBLISH")).status, "BLOCKED");
  assert.equal(state.writes.length, 0);
  const pure = await load("lib/listing/ecManagement.ts");
  assert.equal(pure.ecStateFor(null, "BASE", id, true).state, "UNKNOWN");
  assert.deepEqual([...pure.retainVisibleSelection(new Set(["1", "2"]), ["2"])], ["2"]);
  reset();
  const adapter = await load("lib/listing/base/adapter.ts", {
    "@/lib/base/oauth": "export const getAccessToken=async()=>'test-token';export const isBaseConnected=async()=>true;export class BaseNotConnectedError extends Error{}",
    "@/lib/integrations/writeGuard": "export const assertExternalWriteAllowed=()=>{throw Error('unexpected automatic write')};",
    "@/lib/http/fetchWithTimeout": "export const fetchWithTimeout=async()=>({ok:true,text:async()=>JSON.stringify(f.state().imageResponse)});",
  });
  state.imageResponse={item:{item_id:1234,img1_origin:"https://example.test/confirmed.jpg"}};
  assert.equal(await adapter.addManualBaseImage("1234",1,"https://example.test/source.jpg"),"https://example.test/confirmed.jpg");
  for(const imageResponse of [{error:"image_put_fail"},{errors:["invalid"]},{item:{item_id:1234}},{item:{item_id:999,img1_origin:"https://example.test/wrong.jpg"}}]){
    state.imageResponse=imageResponse;
    await assert.rejects(()=>adapter.addManualBaseImage("1234",1,"https://example.test/source.jpg"));
  }
  state.imageResponse={error:"invalid_item"};
  await assert.rejects(()=>adapter.editManualBaseContent("1234",{title:"Chair",detail:"Updated",price:12000,stock:2}));
  console.log("EC management: boundary checks passed. No live marketplace writes.");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
