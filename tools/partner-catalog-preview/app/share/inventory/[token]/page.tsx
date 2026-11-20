import {PublicCatalog} from '../../../../../../app/share/inventory/[token]/PublicCatalog';
export default async function Page({params}:{params:Promise<{token:string}>}){const {token}=await params;return <PublicCatalog token={token}/>}
