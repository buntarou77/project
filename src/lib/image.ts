// Сжатие изображений на устройстве перед загрузкой (референсы, портфолио).
// Несколько размеров для srcset: 640 / 1024 / 1600 по ширине.

const WIDTHS = [640, 1024, 1600]

async function fileToBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file)
}

async function renderWidth(bmp: ImageBitmap, width: number): Promise<Blob> {
  const scale = Math.min(1, width / bmp.width)
  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, w, h)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.82))
}

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
}

export async function compressImage(file: File): Promise<{ variants: Record<number, Blob>; base: CompressedImage }> {
  const bmp = await fileToBitmap(file)
  const variants: Record<number, Blob> = {}
  for (const w of WIDTHS) {
    if (bmp.width >= w || Object.keys(variants).length === 0) {
      variants[w] = await renderWidth(bmp, w)
    }
  }
  const base = { width: bmp.width, height: bmp.height, blob: variants[WIDTHS[0]] }
  bmp.close()
  return { variants, base }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.readAsDataURL(blob)
  })
}
