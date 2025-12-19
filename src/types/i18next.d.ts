import 'i18next';
import type zhCommon from '../locales/zh/common.json';
import type zhSettings from '../locales/zh/settings.json';
import type zhBookshelf from '../locales/zh/bookshelf.json';
import type zhAbout from '../locales/zh/about.json';
import type zhStatistics from '../locales/zh/statistics.json';
import type zhReader from '../locales/zh/reader.json';
import type zhGroup from '../locales/zh/group.json';
import type zhSearch from '../locales/zh/search.json';
import type zhImport from '../locales/zh/import.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof zhCommon;
      settings: typeof zhSettings;
      bookshelf: typeof zhBookshelf;
      about: typeof zhAbout;
      statistics: typeof zhStatistics;
      reader: typeof zhReader;
      group: typeof zhGroup;
      search: typeof zhSearch;
      import: typeof zhImport;
    };
  }
}
