/**
 * 书籍格式服务入口
 */

// 从类型定义导出
export * from './types';

// 从注册表导出
export {
  registerRenderer,
  getBookFormat,
  isFormatSupported,
  createRenderer,
  createRendererByFormat,
  getSupportedExtensions,
  getRegisteredFormats,
} from './registry';

// 导入各格式渲染器，触发自动注册
import './pdf/PdfRenderer';
import './markdown/MarkdownRenderer';
import './html/HtmlRenderer';
import './epub/EpubRenderer';
import './txt/TxtRenderer';