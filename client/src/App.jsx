import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [images, setImages] = useState([]);
  const [selectedImages, setSelectedImages] = useState(new Set());
  const [previewImage, setPreviewImage] = useState(null);
  const [lightboxImage, setLightboxImage] = useState(null); // Full-screen tap preview
  
  // New States
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const saved = localStorage.getItem('pixiesetHistory');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {}
    }
  }, []);

  const saveToHistory = (galleryUrl, imagesArray, thumbnail) => {
    const name = getGalleryName(galleryUrl);
    // Don't save the full images array in localStorage if it's too big (saves memory)
    const imagesToSave = imagesArray.length > 300 ? undefined : imagesArray;
    
    const newEntry = { 
        url: galleryUrl, 
        name, 
        imgCount: imagesArray.length, 
        thumbnail, 
        images: imagesToSave,
        date: new Date().toISOString() 
    };
    
    setHistory(prev => {
      const filtered = prev.filter(h => h.url !== galleryUrl);
      const updated = [newEntry, ...filtered].slice(0, 15);
      
      try {
          localStorage.setItem('pixiesetHistory', JSON.stringify(updated));
      } catch (e) {
          console.warn("Storage quota exceeded, removing detailed history data");
          const simplified = updated.map(item => ({ ...item, images: undefined }));
          localStorage.setItem('pixiesetHistory', JSON.stringify(simplified));
      }
      return updated;
    });
  };



  const getGalleryName = (urlStr) => {
    try {
      const parsedUrl = new URL(urlStr);
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      return pathParts[0] || 'pixieset_gallery';
    } catch (e) {
      return 'pixieset_gallery';
    }
  };

  const handleExtract = async (e) => {
    if(e) e.preventDefault();
    if (!url) return;

    setStatus('extracting');
    setErrorMessage('');
    setImages([]);
    setSelectedImages(new Set());

    try {
      const response = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to extract gallery');
      }

      const data = await response.json();
      setImages(data.images);
      
      // Auto-select all images by default
      const initialSelection = new Set(data.images);
      setSelectedImages(initialSelection);
      setStatus('preview');
      saveToHistory(url, data.images, data.images[0]);
      
    } catch (error) {
      console.error('Extraction error:', error);
      setStatus('error');
      setErrorMessage(error.message);
    }
  };

  const handleDownloadZip = async () => {
    if (selectedImages.size === 0 || status === 'zipping') return;

    setStatus('zipping');
    setErrorMessage('');

    try {
      const imagesToZip = Array.from(selectedImages);
      const galleryName = getGalleryName(url);
      
      const response = await fetch('/api/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: imagesToZip, filename: galleryName }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create ZIP');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', `${galleryName}.zip`);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      setStatus('success');
      setTimeout(() => setStatus('preview'), 3500);
      
    } catch (error) {
      console.error('Zip error:', error);
      setStatus('error');
      setErrorMessage(error.message);
      // Let user stay in preview mode to try again
      setTimeout(() => setStatus('preview'), 4000);
    }
  };


  const toggleImageSelection = (imgUrl) => {
    const newSelection = new Set(selectedImages);
    if (newSelection.has(imgUrl)) {
      newSelection.delete(imgUrl);
    } else {
      newSelection.add(imgUrl);
    }
    setSelectedImages(newSelection);
  };

  const selectAll = () => {
      setSelectedImages(new Set(images));
  };
  
  const deselectAll = () => setSelectedImages(new Set());

  const loadFromHistory = (h) => {
      setUrl(h.url);
      
      if (h.images && h.images.length > 0) {
          // Instant load from cache!
          setImages(h.images);
          setSelectedImages(new Set(h.images));
          setStatus('preview');
          setErrorMessage('');
      } else {
          // Fallback to re-scraping if images array isn't cached
          setTimeout(() => {
              document.getElementById('extractBtn')?.click();
          }, 100);
      }
  };

  return (
    <div className="app-container">
      <div className="sidebar">
          <div className="sidebar-header">
              <h3>Recent Downloads</h3>
          </div>
          <div className="history-list">
              {history.length === 0 ? <p className="empty-text">No recent downloads</p> : null}
              {history.map((h, i) => (
                  <div key={i} className="history-item" onClick={() => loadFromHistory(h)}>
                      {h.thumbnail && (
                          <img 
                              src={h.thumbnail} 
                              alt="" 
                              className="history-thumb" 
                              onError={(e) => {
                                  e.target.onerror = null;
                                  e.target.src = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='%235f6368' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2' ry='2'></rect><circle cx='8.5' cy='8.5' r='1.5'></circle><polyline points='21 15 16 10 5 21'></polyline></svg>";
                              }}
                          />
                      )}
                      <div className="history-info">
                          <span className="history-name">{h.name}</span>
                          <span className="history-meta">{h.imgCount} images</span>
                      </div>
                  </div>
              ))}
          </div>
      </div>

      <div className="main-content">
          {status !== 'preview' && status !== 'zipping' && status !== 'success' || images.length === 0 ? (
            <main className="main-card">
              <header className="card-header">
                <h1>Pixieset Downloader</h1>
                <p>Instantly extract and download web-resolution galleries</p>
              </header>

              <form onSubmit={handleExtract} className="download-form">
                <div className="input-group">
                  <input
                    type="url"
                    placeholder="Paste Pixieset Gallery URL..."
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                    disabled={status === 'extracting'}
                  />
                </div>

                <button 
                  id="extractBtn"
                  type="submit" 
                  className={`download-btn ${status}`}
                  disabled={status === 'extracting' || !url}
                >
                  {status === 'idle' && 'Extract Gallery'}
                  {status === 'extracting' && (
                    <span className="loading-spinner"></span>
                  )}
                  {status === 'error' && 'Try Again'}
                </button>
              </form>

              {status === 'error' && (
                <div className="error-message">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  <span>{errorMessage}</span>
                </div>
              )}
            </main>
          ) : (
            <main className="preview-container main-card">
              <div className="preview-header">
                <div>
                  <h2>Gallery Preview</h2>
                  <p>
                    {selectedImages.size} of {images.length} images selected
                  </p>
                </div>
                <div className="preview-actions">
                  <button className="secondary-btn" onClick={selectedImages.size === images.length ? deselectAll : selectAll}>
                    {selectedImages.size === images.length ? 'Deselect All' : 'Select All'}
                  </button>
                  <button 
                    className="download-btn primary"
                    onClick={handleDownloadZip}
                    disabled={status === 'zipping' || selectedImages.size === 0}
                  >
                    {status === 'zipping' ? (
                      <><span className="loading-spinner small"></span> Zipping...</>
                    ) : status === 'success' ? (
                      'Downloaded!'
                    ) : (
                      `Download ${selectedImages.size} Images`
                    )}
                  </button>
                  <button className="secondary-btn cancel" onClick={() => setStatus('idle')}>Close</button>
                </div>
              </div>

              {status === 'error' && (
                <div className="error-message">
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="image-grid">
                {images.map((imgUrl, index) => (
                  <div 
                    key={index} 
                    className={`image-card ${selectedImages.has(imgUrl) ? 'selected' : ''}`}
                    onClick={() => toggleImageSelection(imgUrl)}
                    onMouseEnter={() => setPreviewImage(imgUrl)}
                    onMouseLeave={() => setPreviewImage(null)}
                  >
                    <img 
                      src={imgUrl} 
                      alt={`Gallery image ${index + 1}`} 
                      loading="lazy" 
                      onError={(e) => {
                          e.target.parentElement.style.display = 'none';
                      }}
                    />
                    <div className="check-indicator">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                    {/* Expand / Lightbox button (Max sign) */}
                    <button
                      className="expand-btn"
                      onClick={(e) => { e.stopPropagation(); setLightboxImage(imgUrl); }}
                      title="Preview image"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
                      </svg>
                    </button>

                  </div>
                ))}
              </div>

              {previewImage && (
                <div className="hover-preview-overlay">
                  <img src={previewImage} alt="Hover preview" className="hover-preview-image" />
                </div>
              )}
            </main>
          )}
      </div>

      {/* Full-screen Lightbox Modal */}
      {lightboxImage && (
        <div className="lightbox-overlay" onClick={() => setLightboxImage(null)}>
          <button className="lightbox-close" onClick={() => setLightboxImage(null)} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
          <img
            src={lightboxImage}
            alt="Full preview"
            className="lightbox-image"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="lightbox-actions">
            <button
              className="lightbox-select-btn"
              onClick={(e) => { e.stopPropagation(); toggleImageSelection(lightboxImage); }}
            >
              {selectedImages.has(lightboxImage) ? '✓ Selected' : '+ Select'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
