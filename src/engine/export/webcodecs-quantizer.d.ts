// Per-codec quantizer encode options (the constant-QP path) and the HEVC
// bitstream-format config landed in WebCodecs after this TypeScript lib's DOM
// types were cut. They are real, shipped Chromium properties — declare the
// exact runtime shapes the export worker uses so we don't have to cast.
//
// AVC already carries `avc?: AvcEncoderConfig` / encode options in lib.dom, so
// only HEVC and AV1 need adding here (declaration merging extends the globals).

interface HevcEncoderConfig {
  format?: 'annexb' | 'hevc'
}

interface VideoEncoderEncodeOptionsForHevc {
  quantizer?: number
}

interface VideoEncoderEncodeOptionsForAv1 {
  quantizer?: number
}

interface VideoEncoderConfig {
  hevc?: HevcEncoderConfig
}

interface VideoEncoderEncodeOptions {
  hevc?: VideoEncoderEncodeOptionsForHevc
  av1?: VideoEncoderEncodeOptionsForAv1
}
