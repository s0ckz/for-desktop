#pragma once
#include <d3d11.h>

// Desktop BGRA is full-range SDR. Produce limited-range BT.709 NV12 to
// match the VideoFrame colorSpace in screenCapturePatch.ts. Driver defaults
// can produce full-range YUV, which crushes shadows when decoded as limited.
inline void ConfigureCaptureColor(ID3D11VideoContext* context, ID3D11VideoProcessor* processor) {
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE input{};
  input.Usage = 1;  // Conversion for transport, not display enhancement.
  input.RGB_Range = 0;
  input.YCbCr_Matrix = 1;
  input.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
  context->VideoProcessorSetStreamColorSpace(processor, 0, &input);

  D3D11_VIDEO_PROCESSOR_COLOR_SPACE output{};
  output.Usage = 1;
  output.YCbCr_Matrix = 1;
  output.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
  context->VideoProcessorSetOutputColorSpace(processor, &output);
  context->VideoProcessorSetStreamAutoProcessingMode(processor, 0, FALSE);
}
