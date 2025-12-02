export const getSafeAreaInsets = () => {
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  // Android 顶部状态栏通常高度较高，给一个较大的保底值 44px
  const top = isAndroid 
    ? "max(env(safe-area-inset-top), 44px)" 
    : "env(safe-area-inset-top)";
  
  // Android 底部可能有虚拟导航栏，如果 env 无效，给一个较大的安全距离 48px 以防遮挡
  const bottom = isAndroid
    ? "max(env(safe-area-inset-bottom), 48px)"
    : "env(safe-area-inset-bottom)";
  
  return {
    top,
    bottom,
  };
};
