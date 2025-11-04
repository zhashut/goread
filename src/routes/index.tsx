import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Bookshelf } from '../components/Bookshelf';
import { Reader } from '../components/Reader';
import { Settings } from '../components/Settings';

export const AppRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Bookshelf />} />
      <Route path="/reader/:bookId" element={<Reader />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
};