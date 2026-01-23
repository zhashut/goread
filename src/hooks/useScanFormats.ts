import { useState, useCallback } from 'react';
import { BookFormat } from '../services/formats/types';
import { DEFAULT_SCAN_FORMATS } from '../constants/fileTypes';

const STORAGE_KEY = 'scanFormats';

export const useScanFormats = () => {
    const [scanFormats, setScanFormats] = useState<BookFormat[]>(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to parse saved scan formats', e);
        }
        return DEFAULT_SCAN_FORMATS;
    });

    const updateScanFormats = useCallback((formats: BookFormat[]) => {
        setScanFormats(formats);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(formats));
        } catch (e) {
            console.error('Failed to save scan formats', e);
        }
    }, []);

    return {
        scanFormats,
        setScanFormats: updateScanFormats,
    };
};
