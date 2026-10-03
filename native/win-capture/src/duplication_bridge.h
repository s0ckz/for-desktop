#pragma once
#include <d3d11.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <cstring>

// Own the source before ReleaseFrame. Normalize duplication resources into
// a video-processor-compatible SDR BGRA texture entirely on the GPU.
// scRGB HDR input explicitly clips highlights to SDR; this is a diagnostic
// prototype, not an HDR-preserving transport or production tone mapper.
class DuplicationBridge {
 public:
  HRESULT Copy(ID3D11Device* device, ID3D11DeviceContext* context, ID3D11Texture2D* source) {
    D3D11_TEXTURE2D_DESC desc{}; source->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM && desc.Format != DXGI_FORMAT_R16G16B16A16_FLOAT) return E_NOTIMPL;
    HRESULT hr;
    if (!output_ || width_ != desc.Width || height_ != desc.Height || format_ != desc.Format) {
      input_.Reset(); output_.Reset(); srv_.Reset(); rtv_.Reset();
      D3D11_TEXTURE2D_DESC owned = desc;
      owned.Usage = D3D11_USAGE_DEFAULT; owned.CPUAccessFlags = 0; owned.MiscFlags = 0;
      owned.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      if (desc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT && FAILED(hr = device->CreateTexture2D(&owned, nullptr, &input_))) return hr;
      owned.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      owned.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      if (FAILED(hr = device->CreateTexture2D(&owned, nullptr, &output_))) return hr;
      if (desc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT) {
        if (FAILED(hr = device->CreateShaderResourceView(input_.Get(), nullptr, &srv_))) return hr;
        if (FAILED(hr = device->CreateRenderTargetView(output_.Get(), nullptr, &rtv_))) return hr;
        if (!pixel_ && FAILED(hr = CreateShaders(device))) return hr;
      }
      width_ = desc.Width; height_ = desc.Height; format_ = desc.Format;
    }
    if (format_ == DXGI_FORMAT_B8G8R8A8_UNORM) { context->CopyResource(output_.Get(), source); return S_OK; }
    context->CopyResource(input_.Get(), source);
    ID3D11ShaderResourceView* views[] = {srv_.Get()};
    ID3D11RenderTargetView* targets[] = {rtv_.Get()};
    D3D11_VIEWPORT viewport{0, 0, static_cast<float>(width_), static_cast<float>(height_), 0, 1};
    context->IASetInputLayout(nullptr);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertex_.Get(), nullptr, 0);
    context->PSSetShader(pixel_.Get(), nullptr, 0);
    context->RSSetViewports(1, &viewport);
    context->OMSetRenderTargets(1, targets, nullptr);
    context->PSSetShaderResources(0, 1, views);
    context->Draw(3, 0);
    views[0] = nullptr;
    context->PSSetShaderResources(0, 1, views);
    context->OMSetRenderTargets(0, nullptr, nullptr);
    return S_OK;
  }
  ID3D11Texture2D* Texture() const { return output_.Get(); }
 private:
  HRESULT CreateShaders(ID3D11Device* device) {
    const char* shader = R"(
      Texture2D<float4> source : register(t0);
      float4 VS(uint id : SV_VertexID) : SV_Position {
        float2 p = float2((id << 1) & 2, id & 2);
        return float4(p.x * 2 - 1, 1 - p.y * 2, 0, 1);
      }
      float4 PS(float4 position : SV_Position) : SV_Target {
        float3 rgbLinear = saturate(source.Load(int3(int2(position.xy), 0)).rgb);
        float3 gamma = lerp(12.92 * rgbLinear, 1.055 * pow(rgbLinear, 1.0 / 2.4) - 0.055, step(0.0031308, rgbLinear));
        return float4(gamma, 1);
      }
    )";
    Microsoft::WRL::ComPtr<ID3DBlob> vs, ps, errors;
    HRESULT hr = D3DCompile(shader, std::strlen(shader), nullptr, nullptr, nullptr, "VS", "vs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &vs, &errors);
    if (FAILED(hr)) return hr;
    hr = D3DCompile(shader, std::strlen(shader), nullptr, nullptr, nullptr, "PS", "ps_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &ps, &errors);
    if (FAILED(hr)) return hr;
    if (FAILED(hr = device->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr, &vertex_))) return hr;
    return device->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr, &pixel_);
  }
  UINT width_ = 0, height_ = 0;
  DXGI_FORMAT format_ = DXGI_FORMAT_UNKNOWN;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> input_, output_;
  Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> srv_;
  Microsoft::WRL::ComPtr<ID3D11RenderTargetView> rtv_;
  Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex_;
  Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel_;
};
