import { createHashRouter, Navigate } from 'react-router-dom';
import { MainLayout } from '../layouts/MainLayout';
import { Bookshelf } from '../components/Bookshelf';
import { Reader } from '../components/Reader';
import { Settings } from '../components/Settings';
import { Search } from '../components/Search';
import { ImportFiles } from '../components/ImportFiles';
import { ScanResults } from '../components/ScanResults';
import { Statistics } from '../components/Statistics';
import { About } from '../components/About';

export const router = createHashRouter([
  {
    path: '/',
    element: <MainLayout />,
    handle: {
      transition: {
        type: 'fade',
      },
    },
    children: [
      {
        path: '',
        element: <Bookshelf />,
      },
      {
        path: 'reader/:bookId',
        element: <Reader />,
      },
      {
        path: 'settings',
        element: <Settings />,
      },
      {
        path: 'search',
        element: <Search />,
      },
      {
        path: 'import',
        element: <ImportFiles />,
      },
      {
        path: 'import/results',
        element: <ScanResults />,
      },
      {
        path: 'statistics',
        element: <Statistics />,
      },
      {
        path: 'about',
        element: <About />,
      },
      {
        path: '*',
        element: <Navigate to="/" replace />,
      }
    ],
  },
]);
