import { fromIni } from "@aws-sdk/credential-providers";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EconveniCredentialStore } from "../../lib/listing/econveni/credentials";
import { EconveniHttpSession, readForms } from "../../lib/listing/econveni/httpSession";
async function main() {
 const store=new EconveniCredentialStore(new SecretsManagerClient({region:"us-west-2",credentials:fromIni({profile:"Bello"})}));
 const credentials=await store.credentials(); if(!credentials) throw new Error("NOT_CONFIGURED");
 const session=new EconveniHttpSession(); await session.login(credentials);
 const form=await session.registrationForm();
 console.log(JSON.stringify({hiddenNames:form.fields.filter(f=>f.type==="hidden").map(f=>f.name),action:form.fields.filter(f=>f.name==="action").map(f=>f.value)}));
 const page=await session.productPage("https://smart.e-conveni.net/product.php?action=product_update&products_id=10176617&users_id=9350");
 const product=readForms(page).find(f=>f.fields.some(x=>x.name==="products_name"))!;
 const wanted=["products_name","products_quantity","products_price","products_category","mercariShops_categoryId","mercariShops_price","mercariShops_variants","bikou","object"];
 console.log(JSON.stringify({remoteId:"10176617",fields:product.fields.filter(f=>wanted.includes(f.name)),updatedAction:product.fields.filter(f=>f.name==="action").map(f=>f.value)},null,2));
}
void main().catch(()=>{console.error("AUDIT_FAILED");process.exitCode=1;});
