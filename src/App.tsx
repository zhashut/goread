import React from 'react';
import { HashRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
