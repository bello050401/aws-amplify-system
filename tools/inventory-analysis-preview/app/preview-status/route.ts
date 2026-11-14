export const dynamic='force-dynamic';

export function GET() {
  if (process.env.BELLO_PREVIEW_IDENTITY) {
    try {
      const identity = JSON.parse(process.env.BELLO_PREVIEW_IDENTITY);
      const keys = ['revision','deploymentId','environmentId','dataScopeId','verificationFingerprint'];
      if (keys.every(key=>typeof identity[key]==='string'&&identity[key].length>0)) return Response.json(Object.fromEntries(keys.map(key=>[key,identity[key]])),{headers:{'Cache-Control':'no-store'}});
    } catch { /* Invalid host identity must not be accepted. */ }
    return Response.json({error:'INVALID_PREVIEW_IDENTITY'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
  const revision = process.env.BELLO_PREVIEW_REVISION ?? null;
  const deploymentId = process.env.BELLO_PREVIEW_DEPLOYMENT_ID ?? null;
  const environmentId = process.env.BELLO_PREVIEW_ENVIRONMENT_ID ?? process.env.BELLO_PREVIEW_ENVIRONMENT ?? null;
  const dataScopeId = process.env.BELLO_PREVIEW_DATA_SCOPE_ID ?? process.env.BELLO_PREVIEW_DATA_SCOPE ?? null;
  const verificationFingerprint = process.env.BELLO_PREVIEW_VERIFICATION_FINGERPRINT ?? null;
  return Response.json({revision,deploymentId,environmentId,dataScopeId,verificationFingerprint}, {
    status:revision && deploymentId && environmentId && dataScopeId && verificationFingerprint ? 200 : 503,
    headers:{'Cache-Control':'no-store'},
  });
}
