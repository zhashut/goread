import React from 'react';
import { useTranslation } from 'react-i18next';
import { BookFormat } from '../services/formats/types';
import { getFormatDisplayName, SCAN_SUPPORTED_FORMATS } from '../constants/fileTypes';

interface ScanFormatSelectorProps {
    selectedFormats: BookFormat[];
    onFormatsChange: (formats: BookFormat[]) => void;
    disabled?: boolean;
    /** 菜单是否打开（受控） */
    menuOpen: boolean;
    /** 菜单开关状态变化回调 */
    onMenuOpenChange: (open: boolean) => void;
}

export const ScanFormatSelector: React.FC<ScanFormatSelectorProps> = ({
    selectedFormats,
    onFormatsChange,
    disabled,
    menuOpen,
    onMenuOpenChange,
}) => {
    const { t } = useTranslation('import');

    const toggleMenu = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (disabled) return;
        onMenuOpenChange(!menuOpen);
    };

    const toggleFormat = (fmt: BookFormat) => {
        const newFormats = selectedFormats.includes(fmt)
            ? selectedFormats.filter(f => f !== fmt)
            : [...selectedFormats, fmt];
        onFormatsChange(newFormats);
    };

    const allFormats = SCAN_SUPPORTED_FORMATS;
    const isAllSelected = allFormats.every(fmt => selectedFormats.includes(fmt));
    const hasSelection = selectedFormats.some(fmt => allFormats.includes(fmt));

    const toggleAll = () => {
        if (isAllSelected) {
            onFormatsChange(selectedFormats.filter(f => !allFormats.includes(f)));
        } else {
            const newFormats = Array.from(new Set([...selectedFormats, ...allFormats]));
            onFormatsChange(newFormats);
        }
    };

    return (
        <div style={{ position: 'relative' }}>
            <button
                aria-label={t('scanFormatSelector.title')}
                title={t('scanFormatSelector.title')}
                disabled={disabled}
                style={{
                    background: 'none',
                    border: 'none',
                    boxShadow: 'none',
                    borderRadius: 4,
                    cursor: disabled ? 'default' : 'pointer',
                    padding: 0,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: menuOpen || !isAllSelected ? '#f5f5f5' : 'transparent',
                    opacity: disabled ? 0.3 : 1,
                }}
                onClick={toggleMenu}
            >
                <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill={hasSelection && !isAllSelected ? '#d43d3d' : '#333'}
                >
                    <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
                </svg>
            </button>

            {menuOpen && (
                <>
                    <div
                        style={{
                            position: 'fixed',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: 999,
                        }}
                        onClick={() => onMenuOpenChange(false)}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            top: 40,
                            right: 0,
                            background: '#fff',
                            borderRadius: 8,
                            boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                            width: 170,
                            padding: '8px 0',
                            border: '1px solid #f0f0f0',
                            zIndex: 1000,
                            maxHeight: 400,
                            overflowY: 'auto',
                            scrollbarWidth: 'none',
                            msOverflowStyle: 'none',
                            animation: 'fadeIn 0.1s ease-out',
                        }}
                        className="hide-scrollbar"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <style>{`
                            @keyframes fadeIn {
                                from { opacity: 0; transform: scale(0.95); }
                                to { opacity: 1; transform: scale(1); }
                            }
                            .hide-scrollbar::-webkit-scrollbar { display: none; }
                        `}</style>
                        {/* 头部提示项 */}
                        <div
                            style={{
                                padding: '10px 16px',
                                fontSize: 13,
                                color: '#999',
                                borderBottom: '1px solid #f0f0f0',
                                marginBottom: 4,
                                cursor: 'default',
                                userSelect: 'none',
                            }}
                        >
                            {t('scanFormatSelector.hint')}
                        </div>
                        <div
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleAll();
                            }}
                            style={{
                                padding: '10px 16px',
                                fontSize: 14,
                                color: isAllSelected ? '#d43d3d' : '#333',
                                backgroundColor: isAllSelected ? '#fffbfb' : 'transparent',
                                cursor: 'pointer',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                fontWeight: isAllSelected ? 500 : 400,
                            }}
                        >
                            {t('format.all')}
                            {isAllSelected && (
                                <span style={{ color: '#d43d3d', fontSize: 12 }}>✓</span>
                            )}
                        </div>

                        {allFormats.map(fmt => {
                            const checked = selectedFormats.includes(fmt);
                            return (
                                <div
                                    key={fmt}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleFormat(fmt);
                                    }}
                                    style={{
                                        padding: '10px 16px',
                                        fontSize: 14,
                                        color: checked ? '#d43d3d' : '#333',
                                        backgroundColor: checked ? '#fffbfb' : 'transparent',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        fontWeight: checked ? 500 : 400,
                                    }}
                                >
                                    {getFormatDisplayName(fmt)}
                                    {checked && (
                                        <span style={{ color: '#d43d3d', fontSize: 12 }}>✓</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
};
