const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild'),cp=require('node:child_process');
const dir=path.resolve('artifacts/inventory-edit-20261109/benchmark');fs.mkdirSync(dir,{recursive:true});
esbuild.buildSync({entryPoints:['scripts/qa/inventory-edit-aws-benchmark.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:path.join(dir,'index.js'),alias:{'server-only':path.resolve('scripts/qa/inventory-edit-ui/empty.cjs')}});
const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]};
const arn=n=>'arn:aws:dynamodb:us-west-2:203918843421:table/'+n;
const policy={Version:'2012-10-17',Statement:[
 {Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query','dynamodb:Scan','dynamodb:BatchWriteItem','dynamodb:ConditionCheckItem'],Resource:['Inventory','InventoryCategory','Category','InventoryEditJobs'].map(n=>arn(n+'-BELLO-EditQA-20261109'))},
 {Effect:'Allow',Action:['dynamodb:Scan','dynamodb:BatchGetItem'],Resource:[arn('Inventory-j6up24p7lnczdmklzjdt3vrp4y-NONE'),arn('Inventory-j6up24p7lnczdmklzjdt3vrp4y-NONE/index/inventorySearchCompactV1')]}
]};
for(const [name,value]of Object.entries({trust,policy,reads:{kind:'reads',repeats:100},edits:{kind:'edits',repeats:100}}))fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
console.log('Prepared isolated benchmark bundle and narrow IAM policy.');
