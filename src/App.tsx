import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import ErrorBoundary from './components/ErrorBoundary';
import { PageTransitionProvider } from './router/PageTransitionProvider';
import './App.css';

function App() {
  return (
    <ErrorBoundary>
      <PageTransitionProvider>
        <RouterProvider router={router} />
      </PageTransitionProvider>
    </ErrorBoundary>
  );
}

export default App;
