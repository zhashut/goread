/**
 * Volume Key Service
 * 音量键翻页服务，提供跨平台音量键监听能力
 * 采用策略模式，支持 Android/iOS 等多平台扩展
 */

import { logError } from './index';

// ==================== 类型定义 ====================

export type VolumeKeyDirection = 'up' | 'down';
export type VolumeKeyCallback = (direction: VolumeKeyDirection) => void;

/**
 * 音量键桥接接口
 * 各平台需要实现此接口以提供音量键监听能力
 */
export interface IVolumeKeyBridge {
  /** 平台名称 */
  readonly platform: string;
  
  /** 初始化桥接 */
  init(): Promise<void>;
  
  /** 等待桥接就绪 */
  waitForReady(): Promise<void>;
  
  /** 启用/禁用音量键拦截 */
  setEnabled(enabled: boolean): void;
  
  /** 获取当前启用状态 */
  isEnabled(): boolean;
  
  /** 设置音量键回调 */
  onVolumeKey(callback: VolumeKeyCallback | null): void;
  
  /** 清理资源 */
  cleanup(): void;
}

// ==================== 平台检测工具 ====================

const PlatformDetector = {
  /** 检查是否运行在 Tauri 环境 */
  isTauri(): boolean {
    const w = window as any;
    return typeof w.__TAURI__ !== 'undefined' ||
      typeof w.__TAURI_INTERNALS__ !== 'undefined' ||
      typeof w.__TAURI_IPC__ !== 'undefined';
  },
  
  /** 检查是否为 Android 平台 */
  isAndroid(): boolean {
    const ua = navigator.userAgent || '';
    return /Android/i.test(ua);
  },
  
  /** 检查是否为 iOS 平台 */
  isIOS(): boolean {
    const ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/i.test(ua);
  },
  
  /** 检查 Android VolumeKeyBridge 是否可用 */
  hasAndroidBridge(): boolean {
    return typeof (window as any).VolumeKeyBridge !== 'undefined';
  },
  
  /** 检查 Android 桥接是否就绪 */
  isAndroidBridgeReady(): boolean {
    return (window as any).__VOLUME_KEY_BRIDGE_READY__ === true;
  }
};

// ==================== Android 实现 ====================

/**
 * Android 音量键桥接实现
 * 通过 MainActivity.kt 中的 VolumeKeyBridge 进行通信
 */
class AndroidVolumeKeyBridge implements IVolumeKeyBridge {
  readonly platform = 'android';
  
  private callback: VolumeKeyCallback | null = null;
  private enabled = false;
  private initialized = false;
  private bridgeReadyPromise: Promise<void>;
  private bridgeReadyResolve: (() => void) | null = null;
  
  constructor() {
    this.bridgeReadyPromise = new Promise((resolve) => {
      this.bridgeReadyResolve = resolve;
    });
  }
  
  async init(): Promise<void> {
    if (this.initialized) return;
    
    // 注册全局回调（供原生层调用）
    this.registerGlobalCallback();
    
    if (PlatformDetector.hasAndroidBridge() && PlatformDetector.isAndroidBridgeReady()) {
      this.onBridgeReady();
    } else {
      this.waitForBridgeInternal();
    }
  }
  
  /** 注册供原生层调用的全局回调 */
  private registerGlobalCallback(): void {
    (window as any).__onVolumeKey__ = (direction: string) => {
      if (this.callback && (direction === 'up' || direction === 'down')) {
        this.callback(direction as VolumeKeyDirection);
      }
    };
  }
  
  /** 内部等待桥接就绪 */
  private waitForBridgeInternal(): void {
    // 监听原生层发出的就绪事件
    const handler = () => {
      window.removeEventListener('volumeKeyBridgeReady', handler);
      this.onBridgeReady();
    };
    window.addEventListener('volumeKeyBridgeReady', handler);
    
    // 轮询检测，避免遗漏事件
    let attempts = 0;
    const maxAttempts = 50; // 最多等待 5 秒
    const pollInterval = setInterval(() => {
      attempts++;
      if (PlatformDetector.hasAndroidBridge() && PlatformDetector.isAndroidBridgeReady()) {
        clearInterval(pollInterval);
        window.removeEventListener('volumeKeyBridgeReady', handler);
        this.onBridgeReady();
      } else if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        window.removeEventListener('volumeKeyBridgeReady', handler);
        this.initialized = true;
        this.bridgeReadyResolve?.();
      }
    }, 100);
  }
  
  /** 桥接就绪回调 */
  private onBridgeReady(): void {
    if (this.initialized) return;
    
    this.initialized = true;
    this.bridgeReadyResolve?.();
  }
  
  async waitForReady(): Promise<void> {
    if (this.initialized) return;
    await this.bridgeReadyPromise;
  }
  
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    
    if (PlatformDetector.hasAndroidBridge()) {
      try {
        (window as any).VolumeKeyBridge.setEnabled(enabled);
      } catch (error) {
        logError('[VolumeKey:Android] setEnabled failed', { error: String(error), enabled }).catch(() => {});
      }
    }
  }
  
  isEnabled(): boolean {
    if (PlatformDetector.hasAndroidBridge()) {
      try {
        return (window as any).VolumeKeyBridge.isEnabled();
      } catch (error) {
        logError('[VolumeKey:Android] isEnabled failed', { error: String(error) }).catch(() => {});
      }
    }
    return this.enabled;
  }
  
  onVolumeKey(callback: VolumeKeyCallback | null): void {
    this.callback = callback;
  }
  
  cleanup(): void {
    this.callback = null;
    this.setEnabled(false);
  }
}

// ==================== iOS 实现 ====================

/**
 * iOS 音量键桥接实现
 * 通过 Swift 原生层的 VolumeKeyBridge 进行通信
 * 
 * iOS 原生层实现说明：
 * 需要在 AppDelegate.swift 或相应的 ViewController 中：
 * 1. 使用 AVAudioSession 监听音量变化
 * 2. 注入 VolumeKeyBridge JavaScript 接口
 * 3. 通过 WKWebView 的 evaluateJavaScript 调用前端回调
 */
class IOSVolumeKeyBridge implements IVolumeKeyBridge {
  readonly platform = 'ios';
  
  private callback: VolumeKeyCallback | null = null;
  private enabled = false;
  private initialized = false;
  private bridgeReadyPromise: Promise<void>;
  private bridgeReadyResolve: (() => void) | null = null;
  
  constructor() {
    this.bridgeReadyPromise = new Promise((resolve) => {
      this.bridgeReadyResolve = resolve;
    });
  }
  
  async init(): Promise<void> {
    if (this.initialized) return;
    
    // 注册全局回调（供原生层调用）
    this.registerGlobalCallback();
    
    if (this.hasIOSBridge() && this.isIOSBridgeReady()) {
      this.onBridgeReady();
    } else {
      this.waitForBridgeInternal();
    }
  }
  
  /** 检查 iOS VolumeKeyBridge 是否可用 */
  private hasIOSBridge(): boolean {
    return typeof (window as any).VolumeKeyBridge !== 'undefined';
  }
  
  /** 检查 iOS 桥接是否就绪 */
  private isIOSBridgeReady(): boolean {
    return (window as any).__VOLUME_KEY_BRIDGE_READY__ === true;
  }
  
  /** 注册供原生层调用的全局回调 */
  private registerGlobalCallback(): void {
    (window as any).__onVolumeKey__ = (direction: string) => {
      if (this.callback && (direction === 'up' || direction === 'down')) {
        this.callback(direction as VolumeKeyDirection);
      }
    };
  }
  
  /** 内部等待桥接就绪 */
  private waitForBridgeInternal(): void {
    // 监听原生层发出的就绪事件
    const handler = () => {
      window.removeEventListener('volumeKeyBridgeReady', handler);
      this.onBridgeReady();
    };
    window.addEventListener('volumeKeyBridgeReady', handler);
    
    // 轮询检测，避免遗漏事件
    let attempts = 0;
    const maxAttempts = 50; // 最多等待 5 秒
    const pollInterval = setInterval(() => {
      attempts++;
      if (this.hasIOSBridge() && this.isIOSBridgeReady()) {
        clearInterval(pollInterval);
        window.removeEventListener('volumeKeyBridgeReady', handler);
        this.onBridgeReady();
      } else if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        window.removeEventListener('volumeKeyBridgeReady', handler);
        this.initialized = true;
        this.bridgeReadyResolve?.();
      }
    }, 100);
  }
  
  /** 桥接就绪回调 */
  private onBridgeReady(): void {
    if (this.initialized) return;
    
    this.initialized = true;
    this.bridgeReadyResolve?.();
  }
  
  async waitForReady(): Promise<void> {
    if (this.initialized) return;
    await this.bridgeReadyPromise;
  }
  
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    
    if (this.hasIOSBridge()) {
      try {
        (window as any).VolumeKeyBridge.setEnabled(enabled);
      } catch (error) {
        logError('[VolumeKey:iOS] setEnabled failed', { error: String(error), enabled }).catch(() => {});
      }
    }
  }
  
  isEnabled(): boolean {
    if (this.hasIOSBridge()) {
      try {
        return (window as any).VolumeKeyBridge.isEnabled();
      } catch (error) {
        logError('[VolumeKey:iOS] isEnabled failed', { error: String(error) }).catch(() => {});
      }
    }
    return this.enabled;
  }
  
  onVolumeKey(callback: VolumeKeyCallback | null): void {
    this.callback = callback;
  }
  
  cleanup(): void {
    this.callback = null;
    this.setEnabled(false);
  }
}

// ==================== 空实现（非移动端） ====================

/**
 * 空实现，用于非移动端环境
 * 所有操作均为空操作，不会产生任何副作用
 */
class NoopVolumeKeyBridge implements IVolumeKeyBridge {
  readonly platform = 'noop';
  
  async init(): Promise<void> {}
  
  async waitForReady(): Promise<void> {}
  
  setEnabled(_enabled: boolean): void {}
  
  isEnabled(): boolean {
    return false;
  }
  
  onVolumeKey(_callback: VolumeKeyCallback | null): void {}
  
  cleanup(): void {}
}

// ==================== 工厂函数 ====================

/**
 * 根据当前平台创建对应的音量键桥接实例
 */
function createVolumeKeyBridge(): IVolumeKeyBridge {
  if (!PlatformDetector.isTauri()) {
    return new NoopVolumeKeyBridge();
  }
  
  if (PlatformDetector.isAndroid()) {
    return new AndroidVolumeKeyBridge();
  }
  
  if (PlatformDetector.isIOS()) {
    return new IOSVolumeKeyBridge();
  }
  
  return new NoopVolumeKeyBridge();
}

// ==================== 服务封装 ====================

/**
 * 音量键服务
 * 封装平台相关实现，提供统一的 API
 */
class VolumeKeyService {
  private bridge: IVolumeKeyBridge;
  private initialized = false;
  
  constructor() {
    this.bridge = createVolumeKeyBridge();
  }
  
  /** 获取当前平台名称 */
  get platform(): string {
    return this.bridge.platform;
  }
  
  /**
   * 初始化音量键服务
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    
    await this.bridge.init();
    this.initialized = true;
  }
  
  /**
   * 等待服务就绪
   */
  async waitForReady(): Promise<void> {
    await this.bridge.waitForReady();
  }
  
  /**
   * 启用/禁用音量键翻页
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.waitForReady();
    this.bridge.setEnabled(enabled);
  }
  
  /**
   * 设置音量键回调
   */
  onVolumeKey(callback: VolumeKeyCallback | null): void {
    this.bridge.onVolumeKey(callback);
  }
  
  /**
   * 获取当前启用状态
   */
  isEnabled(): boolean {
    return this.bridge.isEnabled();
  }
  
  /**
   * 清理资源
   */
  cleanup(): void {
    this.bridge.cleanup();
  }
}

// 导出单例服务
export const volumeKeyService = new VolumeKeyService();
