import {resolve} from 'node:path';
export function storageModeFromConfig(config = {}) {
  const mode = config.storageMode || 'copy';
  if (!['copy', 'eagle'].includes(mode)) throw Error('Unsupported storageMode; use copy or eagle');
  return mode;
}
export function eagleOnlyReceiptState(receipt, outputRoot) {
  if (!receipt || !/^\d{8,16}$/.test(String(receipt.productId||'')))throw Error('Invalid product receipt');
  const verified = receipt.eagle === 'verified' && Array.isArray(receipt.images) && receipt.images.length>0 &&
    receipt.images.every(x=>x.verified===true && x.itemId && x.filePath);
  return {
    phase:verified?'success':'incomplete',
    copied:0,
    destination:resolve(outputRoot,receipt.productId),
    localStatus:'not_requested',
    storageMode:'eagle',
    postprocess:{...(receipt.postprocess||{}),html:{status:'not_generated_eagle_only'}}
  };
}
