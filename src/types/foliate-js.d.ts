declare module '../../../lib/foliate-js/vendor/zip.js' {
  export function configure(options: any): void;

  export class ZipReader {
    constructor(reader: any, options?: any);
    getEntries(options?: any): Promise<any[]>;
  }

  export class BlobReader {
    constructor(blob: Blob);
  }

  export class TextWriter {
    constructor();
  }

  export class BlobWriter {
    constructor(type?: string);
  }
}

declare module '../../../lib/foliate-js/epub.js' {
  export class EPUB {
    constructor(loader: any);
    init(): Promise<any>;
  }
}

