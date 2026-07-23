import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';

sharp.cache({ memory: 32, files: 0, items: 20 });
sharp.concurrency(1);

try {
  const input = Buffer.from(workerData.input);
  const image = sharp(input, {
    failOn: 'error',
    limitInputPixels: workerData.maxPixels,
    sequentialRead: true,
  });
  const metadata = await image.metadata();
  if (metadata.format !== workerData.expectedFormat) throw new Error('Decoder format does not match the file signature');
  if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) throw new Error('Image dimensions are missing');
  if (metadata.width * metadata.height > workerData.maxPixels) throw new Error('Image exceeds the pixel limit');
  if ((metadata.pages ?? 1) !== 1) throw new Error('Animated or multi-page images are not allowed');
  const { data, info } = await image
    .rotate()
    .webp({ quality: 84, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  parentPort.postMessage({
    ok: true,
    data,
    width: info.width,
    height: info.height,
    mediaType: 'image/webp',
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Image processing failed' });
}
