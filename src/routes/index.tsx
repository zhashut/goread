import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Bookshelf } from '../components/Bookshelf';
import { Reader } from '../components/Reader';
import { Settings } from '../components/Settings';
import { GroupDetail } from '../components/GroupDetail';
import { ImportFiles } from '../components/ImportFiles';
import { ScanResults } from '../components/ScanResults';
import { Search } from '../components/Search';

export const AppRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Bookshelf />} />
      <Route path="/reader/:bookId" element={<Reader />} />
      <Route path="/group/:groupId" element={<GroupDetail />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/search" element={<Search />} />
      <Route path="/import" element={<ImportFiles />} />
      <Route path="/import/results" element={<ScanResults />} />
    </Routes>
  );
};