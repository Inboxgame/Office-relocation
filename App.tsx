import React, { useState, useEffect, useRef } from 'react';
import { NEUTRAL_LIBRARY } from './constants';
import { BackgroundAsset, AssetCategory, AssetSubcategory } from './types';
import { AssetCard } from './components/AssetCard';
import { GeneratorForm } from './components/GeneratorForm';
import { AssetDetailsModal } from './components/AssetDetailsModal';
import { generateBackgroundAssets } from './services/geminiService';
import { checkServerHealth, fetchCloudAssets, uploadCloudAssets, deleteCloudAssets } from './services/api';
import { LayoutGrid, Image as ImageIcon, Sparkles, Download, Loader2, Filter, Trash2, AlertTriangle, Cloud, CloudOff, Wifi, WifiOff, CheckCircle2, Search, RefreshCw, Moon, Sun } from 'lucide-react';
import JSZip from 'jszip';
import { getAssetFilename, generateAssetImageBlob, getAssetsFromDb, saveAssetsToDb, deleteAssetsFromDb } from './utils';

const SUBCATEGORIES: AssetSubcategory[] = [
  'Beauty', 'Food & Beverage', 'Fashion', 'Pets', 'Seasons', 'Home', 'Travel', 'Tech'
];

const POLL_INTERVAL = 1500; // 1.5 seconds for snappier updates

const App: React.FC = () => {
  // Data State
  const [assets, setAssets] = useState<BackgroundAsset[]>([]);

  // UI State
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [viewMode, setViewMode] = useState<'all' | 'generated' | 'neutral'>('all');
  const [selectedCategory, setSelectedCategory] = useState<AssetCategory | 'all'>('all');
  const [selectedSubcategory, setSelectedSubcategory] = useState<AssetSubcategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Selection, Modal & Style State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [viewingAsset, setViewingAsset] = useState<BackgroundAsset | null>(null);
  const [styleReference, setStyleReference] = useState<BackgroundAsset | null>(null);

  // Cloud / Connection State
  const [isConnected, setIsConnected] = useState(false);
  const [isCheckingConnection, setIsCheckingConnection] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  // Ref to store the interval ID for proper cleanup
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialization & Polling Logic
  useEffect(() => {
    // Initialize Theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        setIsDarkMode(true);
        document.documentElement.classList.add('dark');
    } else {
        setIsDarkMode(false);
        document.documentElement.classList.remove('dark');
    }

    let isMounted = true;

    const initialize = async () => {
      setIsCheckingConnection(true);

      // 1. Load Local Assets (Source of Truth for "My Data")
      let localAssets: BackgroundAsset[] = [];
      try {
        localAssets = await getAssetsFromDb();
      } catch (e) {
        console.warn("Could not load local assets", e);
      }

      // Check if component is still mounted
      if (!isMounted) return;

      // Seed if empty
      const isSeeded = localStorage.getItem('backgrounds_ai_seeded');
      if (!isSeeded || localAssets.length === 0) {
         localAssets = NEUTRAL_LIBRARY;
         // Only save if we actually need to seed (db was empty)
         if ((await getAssetsFromDb()).length === 0) {
             await saveAssetsToDb(localAssets);
         }
         localStorage.setItem('backgrounds_ai_seeded', 'true');
      }

      if (!isMounted) return;

      // 2. Check Server
      const serverOnline = await checkServerHealth();

      if (!isMounted) return;

      setIsConnected(serverOnline);

      if (serverOnline) {
        // --- CLOUD MODE ---
        console.log("Connected to Shared Server");
        const cloudAssets = await fetchCloudAssets() || [];

        if (!isMounted) return;

        // SMART SYNC: Check if we have local items that are missing from cloud
        const cloudIds = new Set(cloudAssets.map(a => a.id));
        const assetsToUpload = localAssets.filter(a => !cloudIds.has(a.id));

        if (assetsToUpload.length > 0) {
            console.log(`Syncing ${assetsToUpload.length} local assets to cloud...`);
            setIsSyncing(true);

            // BATCH UPLOAD: Upload in chunks of 5 to prevent "Payload Too Large" errors
            const BATCH_SIZE = 5;
            let successCount = 0;

            for (let i = 0; i < assetsToUpload.length; i += BATCH_SIZE) {
                if (!isMounted) return;
                const batch = assetsToUpload.slice(i, i + BATCH_SIZE);
                const success = await uploadCloudAssets(batch);
                if (success) successCount += batch.length;
            }

            if (!isMounted) return;

            if (successCount > 0) {
                // Refetch from cloud to ensure we have the server's exact state
                const updatedCloud = await fetchCloudAssets();
                if (updatedCloud && isMounted) {
                    setAssets(updatedCloud);
                } else if (isMounted) {
                    // Fallback merge
                    const merged = [...cloudAssets, ...assetsToUpload];
                    const uniqueMerged = Array.from(new Map(merged.map(item => [item.id, item])).values());
                    setAssets(uniqueMerged);
                }
            } else if (isMounted) {
                // If upload completely failed, fallback to showing local
                setAssets(localAssets);
            }
            if (isMounted) setIsSyncing(false);
        } else if (isMounted) {
            // No local changes to push. Show Cloud data.
            // Fallback to local if cloud is empty but we have local data
            setAssets(cloudAssets.length > 0 ? cloudAssets : localAssets);
        }

        // Start Polling - use ref so cleanup can access current value
        intervalRef.current = setInterval(async () => {
            const latest = await fetchCloudAssets();
            if (latest) {
                setIsConnected(true);
                setAssets(prev => {
                    if (prev.length === latest.length && prev[0]?.id === latest[0]?.id) {
                        return prev;
                    }
                    return latest;
                });
            } else {
                setIsConnected(false);
            }
        }, POLL_INTERVAL);

      } else if (isMounted) {
        // --- LOCAL MODE (Fallback) ---
        console.log("Server unreachable, using Local Database");
        setAssets(localAssets);
      }

      if (isMounted) setIsCheckingConnection(false);
    };

    initialize();

    return () => {
        isMounted = false;
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
    };
  }, []);

  const toggleTheme = () => {
      if (isDarkMode) {
          document.documentElement.classList.remove('dark');
          localStorage.setItem('theme', 'light');
          setIsDarkMode(false);
      } else {
          document.documentElement.classList.add('dark');
          localStorage.setItem('theme', 'dark');
          setIsDarkMode(true);
      }
  };

  // Separate Generated vs Library for view filtering
  const generatedAssets = assets.filter(a => !a.id.startsWith('bg_neutral_'));
  const library = assets.filter(a => a.id.startsWith('bg_neutral_'));

  const handleGenerate = async (prompt: string) => {
    setIsLoading(true);
    try {
      const newAssets = await generateBackgroundAssets(
        prompt,
        selectedCategory !== 'all' ? selectedCategory : undefined,
        selectedSubcategory !== 'all' ? selectedSubcategory : undefined,
        styleReference || undefined
      );

      if (newAssets && newAssets.length > 0) {
        if (isConnected) {
            // Upload to Cloud
            const success = await uploadCloudAssets(newAssets);
            if (success) {
                // Optimistic Update: Add to view immediately
                setAssets(prev => [...newAssets, ...prev]);

                // Also save locally as backup
                await saveAssetsToDb(newAssets);
            } else {
                // Cloud Failed? Save locally and alert
                await saveAssetsToDb(newAssets);
                setAssets(prev => [...newAssets, ...prev]);
                alert("Note: Cloud upload failed, but images saved to your local device.");
            }
        } else {
            // Save to Local DB
            await saveAssetsToDb(newAssets);
            setAssets(prev => [...newAssets, ...prev]);
        }

        // Switch view to show new stuff
        setViewMode('generated');
        if (selectedCategory === 'all') setSelectedCategory('all');
        setSearchQuery('');
      }
    } catch (error) {
      console.error("Generation failed", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUseStyle = (asset: BackgroundAsset) => {
      setStyleReference(asset);
      setViewingAsset(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Filter Logic
  const getFilteredAssets = () => {
    let pool = viewMode === 'all'
      ? assets
      : viewMode === 'generated'
        ? generatedAssets
        : library;

    if (selectedCategory !== 'all') {
      pool = pool.filter(asset => asset.category === selectedCategory);
    }

    if (selectedSubcategory !== 'all') {
      pool = pool.filter(asset => asset.subcategory === selectedSubcategory);
    }

    if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        pool = pool.filter(asset =>
            asset.title.toLowerCase().includes(query) ||
            asset.theme.toLowerCase().includes(query) ||
            asset.tags.some(tag => tag.toLowerCase().includes(query)) ||
            asset.prompt.toLowerCase().includes(query)
        );
    }

    return pool;
  };

  const displayAssets = getFilteredAssets();

  // Selection
  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedIds(newSelected);
  };

  // Deletion
  const confirmDelete = async () => {
    const idsToDelete = Array.from(selectedIds) as string[];

    if (isConnected) {
        await deleteCloudAssets(idsToDelete);
    } else {
        await deleteAssetsFromDb(idsToDelete);
    }

    setAssets(prev => prev.filter(a => !selectedIds.has(a.id)));
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  };

  const handleDeleteClick = () => selectedIds.size > 0 && setShowDeleteConfirm(true);
  const handleDeleteSingle = (id: string) => {
    setSelectedIds(new Set([id]));
    setShowDeleteConfirm(true);
  };

  // Download
  const handleDownloadCollection = async () => {
    if (isDownloading || displayAssets.length === 0) return;
    setIsDownloading(true);

    try {
        const zip = new JSZip();
        const folderName = `backgrounds_${viewMode}_${new Date().toISOString().slice(0,10)}`;
        const folder = zip.folder(folderName);

        if (!folder) throw new Error("Failed to create zip folder");

        const itemsToDownload = selectedIds.size > 0
           ? displayAssets.filter(a => selectedIds.has(a.id))
           : displayAssets;

        const tasks = itemsToDownload.map(async (asset) => {
            try {
                const blob = await generateAssetImageBlob(asset);
                if (blob) {
                    const fileName = getAssetFilename(asset);
                    folder.file(fileName, blob);
                }
            } catch (e) {
                console.error(`Failed to generate image for ${asset.id}`, e);
            }
        });

        await Promise.all(tasks);

        const content = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(content);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${folderName}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error("Error creating zip", error);
    } finally {
        setIsDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fdf8f6] dark:bg-gray-950 transition-colors duration-300 pb-20">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 sticky top-0 z-40 transition-colors duration-300">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-brand-500 rounded-lg flex items-center justify-center text-white shadow-lg shadow-brand-500/30">
              <ImageIcon size={24} />
            </div>
            <div>
                <h1 className="font-serif text-2xl font-bold text-gray-900 dark:text-white leading-none">Backgrounds.ai</h1>
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium tracking-wide uppercase mt-1">Asset Prompt Library</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
             {isSyncing && (
                <div className="flex items-center gap-2 text-xs font-medium text-brand-500 bg-brand-50 dark:bg-brand-900/20 px-3 py-1 rounded-full animate-pulse">
                    <RefreshCw size={12} className="animate-spin" />
                    <span>Syncing...</span>
                </div>
             )}
             <button
                onClick={toggleTheme}
                className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
             >
                {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
             </button>
             <div className="hidden md:flex items-center gap-6 text-sm font-medium text-gray-500 dark:text-gray-400">
                <span className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-gray-600 dark:text-gray-300">v1.3.0</span>
             </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-10">

        {/* Generator Section */}
        <div className="max-w-3xl mx-auto">
            <GeneratorForm
              onGenerate={handleGenerate}
              isLoading={isLoading}
              activeCategory={selectedCategory !== 'all' ? selectedCategory : undefined}
              activeSubcategory={selectedSubcategory !== 'all' ? selectedSubcategory : undefined}
              activeStyleRef={styleReference}
              onClearStyle={() => setStyleReference(null)}
            />
        </div>

        {/* Search Bar */}
        <div className="relative mb-8 max-w-7xl mx-auto">
            <Search className="absolute left-4 top-3.5 text-gray-400 dark:text-gray-500" size={20} />
            <input
                type="text"
                placeholder="Search assets by title, tags, prompt, or theme..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 shadow-sm"
            />
        </div>

        {/* Main Toolbar */}
        <div className="mb-8 space-y-4">
            <div className="flex flex-col md:flex-row items-end md:items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-4 gap-4">
                <div className="flex gap-6 w-full md:w-auto overflow-x-auto no-scrollbar">
                    <button
                        onClick={() => setViewMode('all')}
                        className={`pb-4 -mb-4 border-b-2 font-medium transition-colors whitespace-nowrap ${viewMode === 'all' ? 'border-brand-500 text-brand-500' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
                    >
                        All Assets <span className="ml-1 text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full text-gray-500 dark:text-gray-400">{(generatedAssets.length + library.length)}</span>
                    </button>
                    <button
                        onClick={() => setViewMode('neutral')}
                        className={`pb-4 -mb-4 border-b-2 font-medium transition-colors whitespace-nowrap ${viewMode === 'neutral' ? 'border-brand-500 text-brand-500' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
                    >
                        Core Library <span className="ml-1 text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full text-gray-500 dark:text-gray-400">{library.length}</span>
                    </button>
                    <button
                        onClick={() => setViewMode('generated')}
                        className={`pb-4 -mb-4 border-b-2 font-medium transition-colors whitespace-nowrap ${viewMode === 'generated' ? 'border-brand-500 text-brand-500' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
                    >
                        Generated <span className="ml-1 text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full text-gray-500 dark:text-gray-400">{generatedAssets.length}</span>
                    </button>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto justify-end">
                    {selectedIds.size > 0 && (
                        <button
                            onClick={handleDeleteClick}
                            className="flex items-center gap-2 px-4 py-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 text-red-600 dark:text-red-400 rounded-lg text-sm font-medium hover:bg-red-100 dark:hover:bg-red-900/30 transition-all shadow-sm whitespace-nowrap"
                        >
                            <Trash2 size={16} />
                            <span>Delete ({selectedIds.size})</span>
                        </button>
                    )}
                    <button
                        onClick={handleDownloadCollection}
                        disabled={isDownloading || displayAssets.length === 0}
                        className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 disabled:bg-gray-50 disabled:text-gray-300 disabled:dark:bg-gray-800 disabled:dark:text-gray-600 transition-all shadow-sm whitespace-nowrap"
                    >
                        {isDownloading ? <Loader2 size={16} className="animate-spin"/> : <Download size={16} />}
                        <span>{isDownloading ? 'Zipping...' : selectedIds.size > 0 ? `Download Selected (${selectedIds.size})` : `Download All (${displayAssets.length})`}</span>
                    </button>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                    <span className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase mr-2 flex items-center gap-1">
                        <Filter size={12} /> Type:
                    </span>
                    {['all', 'background', 'image', 'icon'].map((cat) => (
                         <button
                            key={cat}
                            onClick={() => setSelectedCategory(cat as AssetCategory | 'all')}
                            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap border ${selectedCategory === cat ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 border-gray-900 dark:border-white' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}`}
                        >
                            {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1) + 's'}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-2">
                    <span className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase mr-2 flex items-center gap-1 whitespace-nowrap">
                         Category:
                    </span>
                    <button
                        onClick={() => setSelectedSubcategory('all')}
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-all whitespace-nowrap border ${selectedSubcategory === 'all' ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 border-brand-200 dark:border-brand-800' : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                    >
                        All Categories
                    </button>
                    {SUBCATEGORIES.map(sub => (
                        <button
                            key={sub}
                            onClick={() => setSelectedSubcategory(sub)}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-all whitespace-nowrap border ${selectedSubcategory === sub ? 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 border-brand-200 dark:border-brand-800' : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                        >
                            {sub}
                        </button>
                    ))}
                </div>
            </div>
        </div>

        {/* Grid */}
        {displayAssets.length === 0 ? (
            <div className="text-center py-20 bg-white dark:bg-gray-900 rounded-2xl border border-dashed border-gray-200 dark:border-gray-800">
                <div className="w-16 h-16 bg-gray-50 dark:bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4 text-gray-300 dark:text-gray-600">
                    <Filter size={32} />
                </div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">No assets match your filters</h3>
                <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto mt-2">Try adjusting your category filters, search terms, or generate new assets.</p>
            </div>
        ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {displayAssets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  isSelected={selectedIds.has(asset.id)}
                  onToggleSelect={handleToggleSelect}
                  onDelete={handleDeleteSingle}
                  onView={setViewingAsset}
                  onUseStyle={handleUseStyle}
                />
            ))}
            </div>
        )}

        {/* Details Modal */}
        {viewingAsset && (
            <AssetDetailsModal
                asset={viewingAsset}
                onClose={() => setViewingAsset(null)}
                onDelete={(id) => {
                    setViewingAsset(null);
                    handleDeleteSingle(id);
                }}
                onUseStyle={handleUseStyle}
            />
        )}

        {/* Delete Confirmation */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={(e) => {
             if(e.target === e.currentTarget) setShowDeleteConfirm(false);
          }}>
            <div className="bg-white dark:bg-gray-900 rounded-2xl max-w-md w-full p-6 shadow-2xl transform transition-all border border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-3 text-red-600 dark:text-red-500 mb-4">
                <div className="bg-red-100 dark:bg-red-900/20 p-2 rounded-full">
                    <AlertTriangle size={24} />
                </div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Delete Assets?</h3>
              </div>
              <p className="text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
                Are you sure you want to delete <strong className="text-gray-900 dark:text-white">{selectedIds.size}</strong> asset{selectedIds.size > 1 ? 's' : ''}?
                {isConnected ? ' This will remove them for ALL users.' : ' This will remove them from your local library.'}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-5 py-2.5 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  className="px-5 py-2.5 bg-red-600 text-white font-medium hover:bg-red-700 rounded-lg transition-all shadow-sm flex items-center gap-2"
                >
                  <Trash2 size={18} /> Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
