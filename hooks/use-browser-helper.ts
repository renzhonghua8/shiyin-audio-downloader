"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import {BrowserHelperError, createBrowserHelperTransport, type BrowserHelperPing, type BrowserHelperTransport, type BrowserHelperRequestOptions} from '@/lib/browser-helper';

export function useBrowserHelper() {
  const transport = useRef<BrowserHelperTransport | null>(null);
  const alive = useRef(false);
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [info, setInfo] = useState<BrowserHelperPing | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const refresh = useCallback(async (silent = false) => {
    const current = transport.current;
    if (!current) return;
    if (alive.current && !silent) setStatus('checking');
    try {
      const result = await current.request('ping', undefined, {timeoutMs: 1500});
      if (alive.current && transport.current === current) { setInfo(result); setStatus('connected'); setError(''); }
    } catch (failure) {
      if (alive.current && transport.current === current) { setInfo(null); setStatus('disconnected'); setError(failure instanceof Error ? failure.message : '浏览器助手未连接'); }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    transport.current = createBrowserHelperTransport(window);
    void refresh();
    const timer = setInterval(() => { void refresh(true); }, 30_000);
    return () => { alive.current = false; clearInterval(timer); transport.current?.dispose(); transport.current = null; };
  }, [refresh]);
  const current = useCallback(() => {
    if (!transport.current) throw new BrowserHelperError('UNAVAILABLE', '浏览器助手尚未连接，请先安装并连接当前网站');
    return transport.current;
  }, []);
  const scan = useCallback(async (url: string, options: BrowserHelperRequestOptions = {}) => {
    if (alive.current) setProgress('正在打开浏览器中的来源页面…');
    try {
      return await current().request('scan', {url}, {...options, timeoutMs: options.timeoutMs ?? 240_000, onProgress: message => {
        if (alive.current) setProgress(message);
        options.onProgress?.(message);
      }});
    } finally { if (alive.current) setProgress(''); }
  }, [current]);
  const download = useCallback((helperId: string) => current().request('download', {helperId}), [current]);
  const downloadBatch = useCallback((helperIds: string[]) => current().request('downloadBatch', {helperIds}), [current]);
  const getDownloadStatus = useCallback((id: string) => current().request('getDownloadStatus', {id}), [current]);
  const cancelPausedScan = useCallback(() => current().cancelPausedScan(), [current]);
  return {status, connected: status === 'connected', info, error, progress, refresh, scan, download, downloadBatch, getDownloadStatus, cancelPausedScan};
}

export type BrowserHelperClient = ReturnType<typeof useBrowserHelper>;
