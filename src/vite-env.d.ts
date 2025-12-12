/// <reference types="vite/client" />

// foliate-js 模块类型声明
declare module '/lib/foliate-js/view.js' {
  export function makeBook(file: File | string): Promise<any>;
  export class View extends HTMLElement {
    open(book: any): Promise<void>;
    close(): void;
    goTo(target: any): Promise<any>;
    goToFraction(frac: number): Promise<void>;
    prev(distance?: number): Promise<void>;
    next(distance?: number): Promise<void>;
    init(options: { lastLocation?: any; showTextStart?: boolean }): Promise<void>;
    book: any;
    renderer: any;
    lastLocation: any;
    history: any;
  }
}
