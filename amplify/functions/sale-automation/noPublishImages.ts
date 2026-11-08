/** The private sale worker has no image export/publication path. */
export async function baseImageUrl():Promise<never>{throw Error('SALE_WORKER_CANNOT_PUBLISH');}
export async function ecImageJpeg():Promise<never>{throw Error('SALE_WORKER_CANNOT_PUBLISH');}
