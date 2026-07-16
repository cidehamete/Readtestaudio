import clsx from 'clsx';
import React, { useEffect, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import 'overlayscrollbars/overlayscrollbars.css';

import TOCView from './TOCView';
import BooknoteView from './BooknoteView';
import TabNavigation from './TabNavigation';
import ChatHistoryView from './ChatHistoryView';

const SidebarContent: React.FC<{
  bookDoc: BookDoc;
  sideBarBookKey: string;
}> = ({ bookDoc, sideBarBookKey }) => {
  const { setHoveredBookKey } = useReaderStore();
  const { setSideBarVisible } = useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();
  const { settings } = useSettingsStore();
  const config = getConfig(sideBarBookKey);
  const [activeTab, setActiveTab] = useState(config?.viewSettings?.sideBarTab || 'toc');
  const [fade, setFade] = useState(false);
  const [targetTab, setTargetTab] = useState(activeTab);
  const isMobile = window.innerWidth < 640 || window.innerHeight < 640;
  const aiEnabled = settings?.aiSettings?.enabled ?? false;

  useEffect(() => {
    if (!sideBarBookKey) return;
    const config = getConfig(sideBarBookKey!)!;
    setActiveTab(config.viewSettings!.sideBarTab!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey]);

  // reset to toc if history tab was active but AI is now disabled
  useEffect(() => {
    if ((activeTab === 'history' || targetTab === 'history') && !aiEnabled) {
      setActiveTab('toc');
      setTargetTab('toc');
    }
  }, [aiEnabled, activeTab, targetTab]);

  // A 'show-sidebar-tab' event (TTS bar TOC/Highlights buttons) can arrive
  // while the tabs view is already mounted — switch tabs in place. Same-tab
  // events are ignored so they don't trigger handleTabChange's mobile
  // "tap active tab to close" behavior.
  useEffect(() => {
    const onShowSidebarTab = (event: CustomEvent) => {
      const { bookKey, tab } = event.detail as { bookKey: string; tab?: string };
      if (bookKey !== sideBarBookKey || !tab || tab === activeTab) return;
      handleTabChange(tab);
    };
    eventDispatcher.on('show-sidebar-tab', onShowSidebarTab);
    return () => eventDispatcher.off('show-sidebar-tab', onShowSidebarTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey, activeTab]);

  const handleTabChange = (tab: string) => {
    if (activeTab === tab) {
      if (isMobile) {
        setHoveredBookKey(sideBarBookKey);
        setSideBarVisible(false);
      }
      return;
    }

    setFade(true);
    const timeout = setTimeout(() => {
      setTargetTab(tab);
      setFade(false);
      setConfig(sideBarBookKey!, config);
      clearTimeout(timeout);
    }, 300);

    setActiveTab(tab);
    const config = getConfig(sideBarBookKey!)!;
    config.viewSettings!.sideBarTab = tab;
  };

  return (
    <>
      <div
        className={clsx(
          'sidebar-content flex h-full min-h-0 flex-grow flex-col shadow-inner',
          'font-sans text-base font-normal sm:text-sm',
        )}
      >
        {targetTab === 'history' ? (
          <ChatHistoryView bookKey={sideBarBookKey} />
        ) : (
          <OverlayScrollbarsComponent
            className='min-h-0 flex-1'
            options={{
              scrollbars: { autoHide: 'scroll', clickScroll: true },
              showNativeOverlaidScrollbars: false,
            }}
            defer
          >
            <div
              className={clsx(
                'scroll-container h-full transition-opacity duration-300 ease-in-out',
                {
                  'opacity-0': fade,
                  'opacity-100': !fade,
                },
              )}
            >
              {targetTab === 'toc' && bookDoc.toc && (
                <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
              )}
              {targetTab === 'annotations' && (
                <BooknoteView type='annotation' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
              )}
              {targetTab === 'bookmarks' && (
                <BooknoteView type='bookmark' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
              )}
            </div>
          </OverlayScrollbarsComponent>
        )}
      </div>
      <div
        className='flex-shrink-0'
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) / 2)',
        }}
      >
        <TabNavigation activeTab={activeTab} onTabChange={handleTabChange} />
      </div>
    </>
  );
};

export default SidebarContent;
