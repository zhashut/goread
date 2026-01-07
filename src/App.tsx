import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import ErrorBoundary from './components/ErrorBoundary';
import { PageTransitionProvider } from './router/PageTransitionProvider';
import { useSystemLanguageSync } from './hooks/useSystemLanguageSync';
import './App.css';
import './utils/polyfills';

function App() {
  // 监听应用从后台返回，自动同步系统语言
  useSystemLanguageSync();

  return (
    <ErrorBoundary>
      <PageTransitionProvider>
        <RouterProvider router={router} />
      </PageTransitionProvider>
    </ErrorBoundary>
  );
}

export default App;
