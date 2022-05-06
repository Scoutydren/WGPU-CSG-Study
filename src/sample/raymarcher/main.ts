import { makeSample, SampleInit} from '../../components/SampleLayout';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { mesh } from '../../meshes/stanfordDragon';

import lightUpdate from './lightUpdate.wgsl';
import vertexWriteGBuffers from './vertexWriteGBuffers.wgsl';
import fragmentWriteGBuffers from './fragmentWriteGBuffers.wgsl';
import vertexTextureQuad from './vertexTextureQuad.wgsl';
import fragmentGBuffersDebugView from './fragmentGBuffersDebugView.wgsl';
import fragmentRayMarching from './fragmentRayMarching.wgsl';

const kMaxNumLights = 1024;
const lightExtentMin = vec3.fromValues(-50, -30, -50);
const lightExtentMax = vec3.fromValues(50, 50, 50);

const init: SampleInit = async ({ canvasRef, gui }) => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  if (canvasRef.current === null) return;
  const context = canvasRef.current.getContext('webgpu');

  const devicePixelRatio = window.devicePixelRatio || 1;
  // Canvas dimensions
  const presentationSize = [
    canvasRef.current.clientWidth * devicePixelRatio,
    canvasRef.current.clientHeight * devicePixelRatio,
  ];

  // Send mouse position to the shader
  var mousePosition = [0.0, 0.0];

  let mousePressed = false;
  canvasRef.current.onmousedown = (event) => {
    event.preventDefault();
    mousePressed = true;
  };
  canvasRef.current.onmouseup = (event) => {
    event.preventDefault();
    mousePressed = false;
  };

  canvasRef.current.onmousemove = (event) => {
    if (mousePressed) {
      mousePosition = [event.movementX, event.movementY];
      const mousePositionData = new Float32Array(mousePosition);
      device.queue.writeBuffer(
        mousePositionUniformBuffer,
        0,
        mousePositionData.buffer,
        mousePositionData.byteOffset,
        mousePositionData.byteLength
      );
    }
  };

  const aspect = presentationSize[0] / presentationSize[1];
  const presentationFormat = context.getPreferredFormat(adapter);
  context.configure({
    device,
    format: presentationFormat,
    size: presentationSize,
  });

  // Create the model vertex buffer.
  const kVertexStride = 8;
  const vertexBuffer = device.createBuffer({
    // position: vec3, normal: vec3, uv: vec2
    size:
      mesh.positions.length * kVertexStride * Float32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  {
    const mapping = new Float32Array(vertexBuffer.getMappedRange());
    for (let i = 0; i < mesh.positions.length; ++i) {
      mapping.set(mesh.positions[i], kVertexStride * i);
      mapping.set(mesh.normals[i], kVertexStride * i + 3);
      mapping.set(mesh.uvs[i], kVertexStride * i + 6);
    }
    vertexBuffer.unmap();
  }

  // Create the model index buffer.
  const indexCount = mesh.triangles.length * 3;
  const indexBuffer = device.createBuffer({
    size: indexCount * Uint16Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.INDEX,
    mappedAtCreation: true,
  });
  {
    const mapping = new Uint16Array(indexBuffer.getMappedRange());
    for (let i = 0; i < mesh.triangles.length; ++i) {
      mapping.set(mesh.triangles[i], 3 * i);
    }
    indexBuffer.unmap();
  }

  // GBuffer texture render targets
  const gBufferTexture2DFloat = device.createTexture({
    size: [...presentationSize, 2],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    format: 'rgba32float',
  });
  const gBufferTextureAlbedo = device.createTexture({
    size: presentationSize,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    format: 'bgra8unorm',
  });
  const gBufferTextureViews = [
    gBufferTexture2DFloat.createView({ baseArrayLayer: 0, arrayLayerCount: 1 }),
    gBufferTexture2DFloat.createView({ baseArrayLayer: 1, arrayLayerCount: 1 }),
    gBufferTextureAlbedo.createView(),
  ];

  const primitive: GPUPrimitiveState = {
    topology: 'triangle-list',
    cullMode: 'back',
  };

  const gBufferTexturesBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'unfilterable-float',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'unfilterable-float',
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'unfilterable-float',
        },
      },
    ],
  });

  const lightsBufferBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: {
          type: 'read-only-storage',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: {
          type: 'uniform',
        },
      },
    ],
  });

  const canvasSizeUniformBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
        },
      },
    ],
  });

  // mouse position bind group layout
  const mousePositionUniformBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform',
        },
      },
    ],
  });

  const textureSamplerBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'read-only-storage',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: {
          type: 'read-only-storage',
        },
      },
    ],
  });

  const rayMarchingPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        gBufferTexturesBindGroupLayout,
        lightsBufferBindGroupLayout,
        canvasSizeUniformBindGroupLayout,
        mousePositionUniformBindGroupLayout,
      ],
    }),
    vertex: {
      module: device.createShaderModule({
        code: vertexTextureQuad,
      }),
      entryPoint: 'main',
    },
    fragment: {
      module: device.createShaderModule({
        code: fragmentRayMarching,
      }),
      entryPoint: 'main',
      targets: [
        {
          format: presentationFormat,
        },
      ],
    },
    primitive,
  });

  const textureQuadPassDescriptor: GPURenderPassDescriptor = {
    colorAttachments: [
      {
        // view is acquired and set in render loop.
        view: undefined,

        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  };

  const settings = {
    mode: 'raymarch',
    shape_id: 0,
  };

  const shapeUniformBuffer = (() => {
    const buffer = device.createBuffer({
      size: Uint32Array.BYTES_PER_ELEMENT,
      mappedAtCreation: true,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    new Uint32Array(buffer.getMappedRange())[0] = settings.shape_id;
    buffer.unmap();
    return buffer;
  })();

  gui.add(settings, 'mode', ['raymarch', 'environment mapping on']);

  //Change shape here
  gui
    .add(settings, 'shape_id', 0, 10)
    .step(1)
    .onChange(() => {
      device.queue.writeBuffer(
        shapeUniformBuffer,
        0,
        new Uint32Array([settings.shape_id])
      );
    });

  const modelUniformBuffer = device.createBuffer({
    size: 4 * 16 * 2, // two 4x4 matrix
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const cameraUniformBuffer = device.createBuffer({
    size: 4 * 16, // 4x4 matrix
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  //Canvas size uniform buffer and bind group
  const canvasSizeUniformBuffer = device.createBuffer({
    size: 4 * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const canvasSizeUniformBindGroup = device.createBindGroup({
    layout: canvasSizeUniformBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          buffer: canvasSizeUniformBuffer,
        },
      },
    ],
  });

  // Mouse Position uniform buffer and bind group
  const mousePositionUniformBuffer = device.createBuffer({
    size: 4 * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const mousePositionUniformBindGroup = device.createBindGroup({
    layout: mousePositionUniformBindGroupLayout,
    entries:  [
      {
        binding: 0,
        resource: {
          buffer: mousePositionUniformBuffer,
        },
      },
    ],
  });

  // const textureSamplerBindGroup = device.createBindGroupLayout({
  //   layout: textureSamplerBindGroupLayout,
  //   entries:  [
  //     {
  //       binding: 0,
  //       resource: {
  //         buffer: ,
  //       },
  //     },
  //   ],
  // });

  const gBufferTexturesBindGroup = device.createBindGroup({
    layout: gBufferTexturesBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: gBufferTextureViews[0],
      },
      {
        binding: 1,
        resource: gBufferTextureViews[1],
      },
      {
        binding: 2,
        resource: gBufferTextureViews[2],
      },
    ],
  });

  // Lights data are uploaded in a storage buffer
  // which could be updated/culled/etc. with a compute shader
  const extent = vec3.create();
  vec3.sub(extent, lightExtentMax, lightExtentMin);
  const lightDataStride = 8;
  const bufferSizeInByte =
    Float32Array.BYTES_PER_ELEMENT * lightDataStride * kMaxNumLights;
  const lightsBuffer = device.createBuffer({
    size: bufferSizeInByte,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });

  // We randomaly populate lights randomly in a box range
  // And simply move them along y-axis per frame to show they are
  // dynamic lightings
  const lightData = new Float32Array(lightsBuffer.getMappedRange());
  const tmpVec4 = vec4.create();
  let offset = 0;
  for (let i = 0; i < kMaxNumLights; i++) {
    offset = lightDataStride * i;
    // position
    for (let i = 0; i < 3; i++) {
      tmpVec4[i] = Math.random() * extent[i] + lightExtentMin[i];
    }
    tmpVec4[3] = 1;
    lightData.set(tmpVec4, offset);
    // color
    tmpVec4[0] = Math.random() * 2;
    tmpVec4[1] = Math.random() * 2;
    tmpVec4[2] = Math.random() * 2;
    // radius
    tmpVec4[3] = 20.0;
    lightData.set(tmpVec4, offset + 4);
  }
  lightsBuffer.unmap();

  const lightExtentBuffer = device.createBuffer({
    size: 4 * 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const lightExtentData = new Float32Array(8);
  lightExtentData.set(lightExtentMin, 0);
  lightExtentData.set(lightExtentMax, 4);
  device.queue.writeBuffer(
    lightExtentBuffer,
    0,
    lightExtentData.buffer,
    lightExtentData.byteOffset,
    lightExtentData.byteLength
  );

  const lightsBufferBindGroup = device.createBindGroup({
    layout: lightsBufferBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          buffer: lightsBuffer,
        },
      },
      {
        binding: 1,
        resource: {
          buffer: shapeUniformBuffer,
        },
      },
    ],
  });

  //--------------------

  // Scene matrices
  const eyePosition = vec3.fromValues(0, 50, -100);
  const upVector = vec3.fromValues(0, 1, 0);
  const origin = vec3.fromValues(0, 0, 0);

  const projectionMatrix = mat4.create();
  mat4.perspective(projectionMatrix, (2 * Math.PI) / 5, aspect, 1, 2000.0);

  const viewMatrix = mat4.create();
  mat4.lookAt(viewMatrix, eyePosition, origin, upVector);

  const viewProjMatrix = mat4.create();
  mat4.multiply(viewProjMatrix, projectionMatrix, viewMatrix);

  // Move the model so it's centered.
  const modelMatrix = mat4.create();
  mat4.translate(modelMatrix, modelMatrix, vec3.fromValues(0, -5, 0));
  mat4.translate(modelMatrix, modelMatrix, vec3.fromValues(0, -40, 0));

  const cameraMatrixData = viewProjMatrix as Float32Array;
  device.queue.writeBuffer(
    cameraUniformBuffer,
    0,
    cameraMatrixData.buffer,
    cameraMatrixData.byteOffset,
    cameraMatrixData.byteLength
  );
  const modelData = modelMatrix as Float32Array;
  device.queue.writeBuffer(
    modelUniformBuffer,
    0,
    modelData.buffer,
    modelData.byteOffset,
    modelData.byteLength
  );
  const invertTransposeModelMatrix = mat4.create();
  mat4.invert(invertTransposeModelMatrix, modelMatrix);
  mat4.transpose(invertTransposeModelMatrix, invertTransposeModelMatrix);
  const normalModelData = invertTransposeModelMatrix as Float32Array;
  device.queue.writeBuffer(
    modelUniformBuffer,
    64,
    normalModelData.buffer,
    normalModelData.byteOffset,
    normalModelData.byteLength
  );
  // Pass the canvas size to shader to help sample from gBuffer textures using coord
  const canvasSizeData = new Float32Array(presentationSize);
  device.queue.writeBuffer(
    canvasSizeUniformBuffer,
    0,
    canvasSizeData.buffer,
    canvasSizeData.byteOffset,
    canvasSizeData.byteLength
  );

  // Rotates the camera around the origin based on time.
  function getCameraViewProjMatrix() {
    const eyePosition = vec3.fromValues(0, 50, -100);

    const rad = Math.PI * (Date.now() / 5000);
    vec3.rotateY(eyePosition, eyePosition, origin, rad);

    const viewMatrix = mat4.create();
    mat4.lookAt(viewMatrix, eyePosition, origin, upVector);

    mat4.multiply(viewProjMatrix, projectionMatrix, viewMatrix);
    return viewProjMatrix as Float32Array;
  }

  function frame() {
    // Sample is no longer the active page.
    if (!canvasRef.current) return;

    const cameraViewProj = getCameraViewProjMatrix();
    device.queue.writeBuffer(
      cameraUniformBuffer,
      0,
      cameraViewProj.buffer,
      cameraViewProj.byteOffset,
      cameraViewProj.byteLength
    );

    const commandEncoder = device.createCommandEncoder();
    {
      if (settings.mode === 'environment mapping on') {
        // TODO
      } else {
        // Deferred rendering
        textureQuadPassDescriptor.colorAttachments[0].view = context
          .getCurrentTexture()
          .createView();
        const rayMarchingPass = commandEncoder.beginRenderPass(
          textureQuadPassDescriptor
        );
        rayMarchingPass.setPipeline(rayMarchingPipeline);
        rayMarchingPass.setBindGroup(0, gBufferTexturesBindGroup);
        rayMarchingPass.setBindGroup(1, lightsBufferBindGroup);
        rayMarchingPass.setBindGroup(2, canvasSizeUniformBindGroup);
        rayMarchingPass.setBindGroup(3, mousePositionUniformBindGroup);
        rayMarchingPass.draw(6);
        rayMarchingPass.end();
      }
    }
    device.queue.submit([commandEncoder.finish()]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
};

const rayMarching: () => JSX.Element = () =>
  makeSample({
    name: 'Ray Marching',
    description: `This example shows how to do ray marching with webgpu.`,
    gui: true,
    init,
    sources: [
      {
        name: __filename.substr(__dirname.length + 1),
        contents: __SOURCE__,
      },
      {
        name: 'vertexWriteGBuffers.wgsl',
        contents: vertexWriteGBuffers,
        editable: true,
      },
      {
        name: 'fragmentWriteGBuffers.wgsl',
        contents: fragmentWriteGBuffers,
        editable: true,
      },
      {
        name: 'vertexTextureQuad.wgsl',
        contents: vertexTextureQuad,
        editable: true,
      },
      {
        name: 'fragmentGBuffersDebugView.wgsl',
        contents: fragmentGBuffersDebugView,
        editable: true,
      },
      {
        name: 'fragmentRayMarching.wgsl',
        contents: fragmentRayMarching,
        editable: true,
      },
      {
        name: 'lightUpdate.wgsl',
        contents: lightUpdate,
        editable: true,
      },
    ],
    filename: __filename,
  });

export default rayMarching;
