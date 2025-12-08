/**
 * 书籍格式服务入口
 */

import { BookFormat, IBookRenderer, RendererRegistration } from './types';

export * from './types';

/** 渲染器注册表 */
const rendererRegistry: Map<string, RendererRegistration> = new Map();

/** 注册渲染器 */
export function registerRenderer(registration: RendererRegistration): void {
  rendererRegistry.set(registration.format, registration);
  
  for (const ext of registration.extensions) {
    const normalizedExt = ext.toLowerCase().replace(/^\./, '');
    rendererRegistry.set(`ext:${normalizedExt}`, registration);
  }
}

/** 从路径提取扩展名 */
function getFileExtension(filePath: string): string {
  const match = filePath.toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : '';
}

/** 根据文件路径获取书籍格式 */
export function getBookFormat(filePath: string): BookFormat | null {
  const ext = getFileExtension(filePath);
  const registration = rendererRegistry.get(`ext:${ext}`);
  return registration?.format ?? null;
}

/** 检查文件格式是否支持 */
export function isFormatSupported(filePath: string): boolean {
  return getBookFormat(filePath) !== null;
}

/** 根据文件路径创建渲染器 */
export function createRenderer(filePath: string): IBookRenderer {
  const ext = getFileExtension(filePath);
  const registration = rendererRegistry.get(`ext:${ext}`);
  
  if (!registration) {
    throw new Error(`不支持的书籍格式: .${ext}`);
  }
  
  return registration.factory();
}

/** 根据格式类型创建渲染器 */
export function createRendererByFormat(format: BookFormat): IBookRenderer {
  const registration = rendererRegistry.get(format);
  
  if (!registration) {
    throw new Error(`不支持的书籍格式: ${format}`);
  }
  
  return registration.factory();
}

/** 获取所有支持的扩展名 */
export function getSupportedExtensions(): string[] {
  const extensions: string[] = [];
  
  for (const [key, reg] of rendererRegistry.entries()) {
    if (!key.startsWith('ext:')) {
      extensions.push(...reg.extensions);
    }
  }
  
  return [...new Set(extensions)];
}

/** 获取所有已注册的格式 */
export function getRegisteredFormats(): RendererRegistration[] {
  const formats: RendererRegistration[] = [];
  
  for (const [key, reg] of rendererRegistry.entries()) {
    if (!key.startsWith('ext:')) {
      formats.push(reg);
    }
  }
  
  return formats;
}

// 各渲染器在导入时自动注册，支持按需加载
