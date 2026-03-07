/**
 * foliate-js 文本遍历器类型声明
 * 遍历 Range 或 Document 中的文本节点，配合分词器生成 [name, Range] 对
 */

type SegmenterFunc = (
  strs: string[],
  makeRange: (startIndex: number, startOffset: number, endIndex: number, endOffset: number) => Range,
) => Generator<[string, Range]>;

type AcceptNodeFunc = (node: Node) => number;

/**
 * 遍历给定范围或文档中的文本节点，使用分词器拆分后生成 [name, Range] 序列
 */
export const textWalker: (
  x: Range | Document | DocumentFragment,
  func: SegmenterFunc,
  filterFunc?: AcceptNodeFunc,
) => Generator<[string, Range]>;
