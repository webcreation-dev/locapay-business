import React, { useState, useEffect, useCallback } from 'react';
import './index.css';

export default function FacebookGroups() {
  const [fbGroups, setFbGroups] = useState([]);
  const [fbIsLoadingGroups, setFbIsLoadingGroups] = useState(false);
  const [fbIsSubmittingGroup, setFbIsSubmittingGroup] = useState(false);
  const [fbGroupsAddModal, setFbGroupsAddModal] = useState(false);
  const [fbAddUrl, setFbAddUrl] = useState('');
  const [fbAddName, setFbAddName] = useState('');
  const [fbAddError, setFbAddError] = useState('');
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [toast, setToast] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null); // { type: 'validate' | 'reject', groupId: string, groupName: string }

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  
  // Sidebar stats states
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarGroup, setSidebarGroup] = useState(null);
  const [sidebarData, setSidebarData] = useState([]);
  const [isLoadingSidebar, setIsLoadingSidebar] = useState(false);

  // Sorting
  const [sortConfig, setSortConfig] = useState({ key: 'daily_avg_posts', direction: 'asc' });

  const requestSort = (key) => {
    let direction = 'desc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc';
    }
    setSortConfig({ key, direction });
  };

  const openStatsSidebar = async (group) => {
    setSidebarGroup(group);
    setIsSidebarOpen(true);
    setIsLoadingSidebar(true);
    setSidebarData([]);
    try {
      const response = await fetch(`/api/facebook/groups/${encodeURIComponent(group.group_id)}/daily-stats`);
      const data = await response.json();
      setSidebarData(data);
    } catch (e) {
      console.error('Erreur chargement stats sidebar', e);
    } finally {
      setIsLoadingSidebar(false);
    }
  };

  // La suppression (DELETE) a été remplacée par un rejet (PATCH is_validated = false)
  // pour garder une trace du groupe.

  // ─── EFFACER TOAST APRÈS 8s ───────────────────────────
  useEffect(() => {
    if (toast && !toast.persistent) {
      const id = setTimeout(() => setToast(null), 8000);
      return () => clearTimeout(id);
    }
  }, [toast]);

  const [showRejected, setShowRejected] = useState(false);

  const fetchFbGroups = useCallback(async (showLoader = false) => {
    if (showLoader) setFbIsLoadingGroups(true);
    try {
      const res = await fetch(`/api/facebook/groups${showRejected ? '?all=true' : ''}`);
      const data = await res.json();
      setFbGroups(data);
    } catch (e) {
      console.error('fetchFbGroups error', e);
    } finally {
      if (showLoader) setFbIsLoadingGroups(false);
    }
  }, [showRejected]);

  useEffect(() => {
    fetchFbGroups(true);
  }, [fetchFbGroups]);

  const handleUpdateGroupName = async (groupId, newName) => {
    if (!newName || !newName.trim()) return;
    try {
      const res = await fetch(`/api/facebook/groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_name: newName.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setToast({ message: '✅ Nom du groupe mis à jour', type: 'success' });
        fetchFbGroups();
      } else throw new Error(data.error);
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    } finally {
      setEditingGroupId(null);
      setEditingGroupName('');
    }
  };

  const handleValidateGroup = async (groupId) => {
    try {
      const res = await fetch(`/api/facebook/groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_validated: true }),
      });
      const data = await res.json();
      if (data.success) {
        setToast({ message: '✅ Groupe validé', type: 'success' });
        fetchFbGroups();
      } else throw new Error(data.error);
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    } finally {
      setConfirmAction(null);
    }
  };

  const handleRejectGroup = async (groupId) => {
    try {
      const res = await fetch(`/api/facebook/groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_validated: false }),
      });
      const data = await res.json();
      if (data.success) {
        setToast({ message: '🚫 Groupe rejeté', type: 'success' });
        fetchFbGroups();
      } else throw new Error(data.error);
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    } finally {
      setConfirmAction(null);
    }
  };

  const processConfirmAction = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'validate') {
      handleValidateGroup(confirmAction.groupId);
    } else if (confirmAction.type === 'reject') {
      handleRejectGroup(confirmAction.groupId);
    }
  };

  const handleResetGroupValidation = async (groupId) => {
    try {
      const res = await fetch(`/api/facebook/groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_validated: null }),
      });
      const data = await res.json();
      if (data.success) {
        setToast({ message: '↩️ Décision annulée', type: 'success' });
        fetchFbGroups();
      } else throw new Error(data.error);
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    }
  };

  const handleAddGroupFromModal = async (e) => {
    e.preventDefault();
    if (!fbAddUrl.trim()) return;
    setFbIsSubmittingGroup(true);
    setFbAddError('');
    try {
      const res = await fetch('/api/facebook/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_url: fbAddUrl.trim(), group_name: fbAddName.trim() || undefined }),
      });
      const data = await res.json();
      if (data.success && data.inserted > 0) {
        setToast({ message: '✅ Groupe ajouté !', type: 'success' });
        setFbGroupsAddModal(false);
        setFbAddUrl('');
        setFbAddName('');
      } else {
        throw new Error(data.errors?.[0]?.error || data.error || 'Erreur inconnue');
      }
    } catch (e) {
      setFbAddError(e.message);
    } finally {
      setFbIsSubmittingGroup(false);
      fetchFbGroups();
    }
  };

  // Pagination & Sorting logic
  const sortedGroups = React.useMemo(() => {
    let sortableItems = [...fbGroups];
    if (sortConfig !== null) {
      sortableItems.sort((a, b) => {
        let aValue = a[sortConfig.key];
        let bValue = b[sortConfig.key];
        
        if (sortConfig.key === 'daily_avg_posts') {
           aValue = parseFloat(aValue) || 0;
           bValue = parseFloat(bValue) || 0;
        } else if (sortConfig.key === 'processed' || sortConfig.key === 'total_posts') {
           aValue = parseInt(aValue) || 0;
           bValue = parseInt(bValue) || 0;
        } else if (sortConfig.key === 'first_post_date' || sortConfig.key === 'last_scraped_at') {
           aValue = new Date(aValue).getTime() || 0;
           bValue = new Date(bValue).getTime() || 0;
        } else if (sortConfig.key === 'group_name') {
           aValue = (aValue || '').toLowerCase();
           bValue = (bValue || '').toLowerCase();
        }

        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableItems;
  }, [fbGroups, sortConfig]);

  const totalPages = Math.ceil(sortedGroups.length / itemsPerPage);
  const currentGroups = sortedGroups.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const totalPosts = fbGroups.reduce((acc, g) => acc + parseInt(g.total_posts || 0), 0);
  const totalProcessed = fbGroups.reduce((acc, g) => acc + parseInt(g.processed || 0), 0);
  const totalPending = fbGroups.reduce((acc, g) => acc + parseInt(g.pending || 0), 0);
  const totalActiveGroups = fbGroups.filter(g => g.is_validated !== false).length;
  const totalPostsYesterday = fbGroups.reduce((acc, g) => acc + parseInt(g.posts_yesterday || 0), 0);
  const totalProcessedYesterday = fbGroups.reduce((acc, g) => acc + parseInt(g.processed_yesterday || 0), 0);

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflowY: 'auto', fontFamily: 'var(--font-family)', display: 'flex', flexDirection: 'column', background: '#f1f5f9' }}>
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      )}

      {/* Header with Stats */}
      <header style={{ background: 'linear-gradient(135deg, #1877f2 0%, #0d5abf 100%)', color: '#fff', padding: '24px 32px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <span style={{ fontSize: '32px' }}>👥</span>
            <div>
              <h1 style={{ fontWeight: '700', fontSize: '24px', margin: 0, color: '#fff' }}>Gestion des Groupes Facebook</h1>
              <div style={{ fontSize: '13px', opacity: 0.9, marginTop: '4px' }}>Surveillez et validez vos sources d'importation</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)' }}>
              <input 
                type="checkbox" 
                checked={showRejected} 
                onChange={(e) => setShowRejected(e.target.checked)} 
                style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: '#1877f2' }}
              />
              Afficher rejetés
            </label>
            <button
              onClick={() => setFbGroupsAddModal(true)}
              style={{ background: '#fff', color: '#1877f2', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', transition: 'transform 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
              onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
            >
              <span style={{ fontSize: '18px' }}>+</span> Ajouter un groupe
            </button>
          </div>
        </div>

        {/* Stats Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>Groupes Suivis</div>
            <div style={{ fontSize: '28px', fontWeight: '700' }}>{totalActiveGroups}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>Total Posts</div>
            <div style={{ fontSize: '28px', fontWeight: '700', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              {totalPosts}
              <span style={{ fontSize: '14px', fontWeight: '600', opacity: 0.9 }}>
                ({totalPostsYesterday > 0 ? '+' : ''}{totalPostsYesterday} hier)
              </span>
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>Biens Créés</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: '#86efac', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              {totalProcessed}
              <span style={{ fontSize: '14px', fontWeight: '600', opacity: 0.9 }}>
                ({totalProcessedYesterday > 0 ? '+' : ''}{totalProcessedYesterday} hier)
              </span>
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>En Attente</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: '#fef08a' }}>{totalPending}</div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main style={{ flex: 1, padding: '32px', maxWidth: '1400px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        {fbIsLoadingGroups ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#94a3b8', fontSize: '16px' }}>Chargement des groupes...</div>
        ) : fbGroups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 40px', background: '#fff', borderRadius: '16px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: '64px', marginBottom: '24px' }}>👥</div>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#1e293b', marginBottom: '12px' }}>Aucun groupe enregistré</div>
            <div style={{ fontSize: '15px', color: '#64748b', marginBottom: '32px' }}>Ajoutez votre premier groupe Facebook pour commencer à scraper des annonces.</div>
            <button onClick={() => setFbGroupsAddModal(true)} style={{ background: '#1877f2', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '600', fontSize: '15px', cursor: 'pointer', boxShadow: '0 4px 12px rgba(24,119,242,0.3)' }}>+ Ajouter un groupe</button>
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: '16px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '14px' }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                  <th onClick={() => requestSort('group_name')} style={{ cursor: 'pointer', background: '#f8fafc', padding: '18px 24px', textAlign: 'left', fontWeight: '800', color: '#0f172a', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid #cbd5e1', borderTopLeftRadius: '16px' }}>Nom du Groupe {sortConfig.key === 'group_name' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                  <th onClick={() => requestSort('first_post_date')} style={{ cursor: 'pointer', background: '#f8fafc', padding: '18px 24px', textAlign: 'center', fontWeight: '800', color: '#0f172a', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap', borderBottom: '2px solid #cbd5e1' }}>Depuis le {sortConfig.key === 'first_post_date' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                  <th onClick={() => requestSort('daily_avg_posts')} style={{ cursor: 'pointer', background: '#e0e7ff', padding: '18px 24px', textAlign: 'center', fontWeight: '800', color: '#1e3a8a', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap', borderBottom: '2px solid #cbd5e1' }}>Moyenne/J {sortConfig.key === 'daily_avg_posts' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                  <th onClick={() => requestSort('processed')} style={{ cursor: 'pointer', background: '#f8fafc', padding: '18px 24px', textAlign: 'center', fontWeight: '800', color: '#0f172a', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap', borderBottom: '2px solid #cbd5e1' }}>Biens créés {sortConfig.key === 'processed' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}</th>
                  <th style={{ background: '#f8fafc', padding: '18px 24px', textAlign: 'center', fontWeight: '800', color: '#0f172a', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid #cbd5e1' }}>Statut</th>
                  <th style={{ background: '#f8fafc', padding: '18px 24px', textAlign: 'center', fontWeight: '800', color: '#0f172a', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid #cbd5e1', borderTopRightRadius: '16px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {currentGroups.map((group, idx) => (
                  <tr key={group.group_id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 0 ? '#fff' : '#fafbff', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f0f7ff'}
                    onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? '#fff' : '#fafbff'}
                  >
                    {/* Nom éditable */}
                    <td style={{ padding: '16px 24px', minWidth: '240px', maxWidth: '360px' }}>
                      {editingGroupId === group.group_id ? (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input
                            autoFocus
                            value={editingGroupName}
                            onChange={e => setEditingGroupName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleUpdateGroupName(group.group_id, editingGroupName);
                              if (e.key === 'Escape') { setEditingGroupId(null); setEditingGroupName(''); }
                            }}
                            onBlur={() => handleUpdateGroupName(group.group_id, editingGroupName)}
                            style={{ flex: 1, padding: '8px 12px', border: '2px solid #1877f2', borderRadius: '8px', fontSize: '14px', outline: 'none', background: '#fff', boxShadow: '0 2px 8px rgba(24,119,242,0.1)' }}
                          />
                        </div>
                      ) : (
                        <div
                          onClick={() => { setEditingGroupId(group.group_id); setEditingGroupName(group.group_name || ''); }}
                          title="Cliquer pour modifier le nom"
                          style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '6px 10px', borderRadius: '8px', transition: 'background 0.15s' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#e8f0fe'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ fontWeight: '600', color: '#1e293b', fontSize: '15px' }}>{group.group_name || <em style={{ color: '#94a3b8' }}>Sans nom</em>}</span>
                          <span style={{ fontSize: '12px', color: '#94a3b8', opacity: 0 }} className="edit-hint">✏️</span>
                        </div>
                      )}
                    </td>

                    {/* Depuis le */}
                    <td style={{ padding: '16px 24px', textAlign: 'center', fontWeight: '600', color: '#475569' }}>
                      {group.first_post_date ? new Date(group.first_post_date).toLocaleDateString('fr-FR') : '—'}
                    </td>

                    {/* Moyenne Journalière */}
                    <td style={{ padding: '16px 24px', textAlign: 'center', background: idx % 2 === 0 ? '#eef2ff' : '#f5f7ff' }}>
                      <div style={{ fontSize: '18px', fontWeight: '800', color: '#3730a3' }}>
                        {Math.round(group.daily_avg_posts || 0)}
                      </div>
                      <div style={{ fontSize: '11px', color: '#6366f1', fontWeight: '700', textTransform: 'uppercase' }}>biens/j</div>
                      <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: '600', marginTop: '4px' }}>
                        sur {Math.round(group.daily_total_avg_posts || 0)} posts/j
                      </div>
                    </td>

                    {/* Biens créés */}
                    <td style={{ padding: '16px 24px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontWeight: '700', fontSize: '18px', color: '#1e293b' }}>{parseInt(group.processed) || 0}</span>
                      </div>
                    </td>

                    {/* Statut validation */}
                    <td style={{ padding: '16px 24px', textAlign: 'center' }}>
                      {group.is_validated === true && (
                        <span style={{ background: '#dcfce7', color: '#15803d', padding: '6px 14px', borderRadius: '20px', fontWeight: '700', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px', border: '1px solid #bbf7d0' }}>✅ Validé</span>
                      )}
                      {group.is_validated === false && (
                        <span style={{ background: '#fee2e2', color: '#dc2626', padding: '6px 14px', borderRadius: '20px', fontWeight: '700', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px', border: '1px solid #fecaca' }}>🚫 Rejeté</span>
                      )}
                      {group.is_validated === null && (
                        <span style={{ background: '#f1f5f9', color: '#64748b', padding: '6px 14px', borderRadius: '20px', fontWeight: '600', fontSize: '12px', border: '1px solid #e2e8f0' }}>— En attente</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '16px 24px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', alignItems: 'center' }}>
                        {group.is_validated === null && (
                          <>
                            {/* Valider */}
                            <button
                              onClick={() => setConfirmAction({ type: 'validate', groupId: group.group_id, groupName: group.group_name })}
                              style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s', boxShadow: '0 2px 8px rgba(34,197,94,0.3)' }}
                              onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'scale(1.02)'; }}
                              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1)'; }}
                              title="Valider ce groupe"
                            >
                              ✅ Valider
                            </button>

                            {/* Rejeter */}
                            <button
                              onClick={() => setConfirmAction({ type: 'reject', groupId: group.group_id, groupName: group.group_name })}
                              style={{ background: 'linear-gradient(135deg, #f87171, #dc2626)', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s', boxShadow: '0 2px 8px rgba(220,38,38,0.3)' }}
                              onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'scale(1.02)'; }}
                              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1)'; }}
                              title="Rejeter ce groupe"
                            >
                              🚫 Rejeter
                            </button>
                          </>
                        )}

                        {/* Voir Stats */}
                        <button
                          onClick={() => openStatsSidebar(group)}
                          style={{ background: '#f8fafc', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#f1f5f9'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f8fafc'; }}
                          title="Statistiques de scraping du groupe"
                        >
                          📈 Stats
                        </button>

                        {/* Voir sur Facebook (Toujours à la fin) */}
                        {group.group_url && (
                          <a
                            href={group.group_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ background: '#e8f0fe', color: '#1877f2', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'background 0.15s' }}
                            title="Voir le groupe sur Facebook"
                          >
                            👁️ Voir
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div style={{ padding: '20px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
                <div style={{ fontSize: '13px', color: '#64748b' }}>
                  Affichage de <strong>{(currentPage - 1) * itemsPerPage + 1}</strong> à <strong>{Math.min(currentPage * itemsPerPage, fbGroups.length)}</strong> sur <strong>{fbGroups.length}</strong> groupes
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    style={{ padding: '8px 16px', background: currentPage === 1 ? '#f1f5f9' : '#fff', color: currentPage === 1 ? '#94a3b8' : '#1e293b', border: '1px solid #cbd5e1', borderRadius: '6px', fontWeight: '600', cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}
                  >
                    Précédent
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', fontWeight: '600', color: '#475569' }}>
                    Page {currentPage} / {totalPages}
                  </div>
                  <button 
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    style={{ padding: '8px 16px', background: currentPage === totalPages ? '#f1f5f9' : '#fff', color: currentPage === totalPages ? '#94a3b8' : '#1e293b', border: '1px solid #cbd5e1', borderRadius: '6px', fontWeight: '600', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }}
                  >
                    Suivant
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Modal Ajouter un groupe */}
      {fbGroupsAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}
          onClick={e => { if (e.target === e.currentTarget) setFbGroupsAddModal(false); }}
        >
          <div style={{ background: '#fff', borderRadius: '24px', padding: '40px', width: '100%', maxWidth: '500px', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
              <h2 style={{ fontSize: '22px', fontWeight: '800', color: '#1e293b', margin: 0 }}>👥 Ajouter un Groupe</h2>
              <button onClick={() => { setFbGroupsAddModal(false); setFbAddError(''); }} style={{ background: '#f1f5f9', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#64748b', padding: '8px', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background='#e2e8f0'} onMouseLeave={e=>e.currentTarget.style.background='#f1f5f9'}>✕</button>
            </div>
            <form onSubmit={handleAddGroupFromModal} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {fbAddError && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#ef4444', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '8px', animation: 'fadeIn 0.3s' }}>
                  <span>❌</span> {fbAddError}
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', color: '#475569', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>URL ou ID du Groupe *</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={fbAddUrl}
                  onChange={e => { setFbAddUrl(e.target.value); if (fbAddError) setFbAddError(''); }}
                  placeholder="https://www.facebook.com/groups/123456789/"
                  style={{ width: '100%', padding: '14px 16px', border: `2px solid ${fbAddError ? '#ef4444' : '#e2e8f0'}`, borderRadius: '12px', fontSize: '15px', outline: 'none', transition: 'all 0.2s', boxSizing: 'border-box' }}
                  onFocus={e => { e.target.style.borderColor = '#1877f2'; e.target.style.boxShadow = '0 0 0 4px rgba(24,119,242,0.1)'; }}
                  onBlur={e => { e.target.style.borderColor = fbAddError ? '#ef4444' : '#e2e8f0'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', color: '#475569', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nom du Groupe (facultatif)</label>
                <input
                  type="text"
                  value={fbAddName}
                  onChange={e => setFbAddName(e.target.value)}
                  placeholder="Ex: Immo Cotonou"
                  style={{ width: '100%', padding: '14px 16px', border: '2px solid #e2e8f0', borderRadius: '12px', fontSize: '15px', outline: 'none', transition: 'all 0.2s', boxSizing: 'border-box' }}
                  onFocus={e => { e.target.style.borderColor = '#1877f2'; e.target.style.boxShadow = '0 0 0 4px rgba(24,119,242,0.1)'; }}
                  onBlur={e => { e.target.style.borderColor = '#e2e8f0'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                <button type="button" onClick={() => { setFbGroupsAddModal(false); setFbAddError(''); }}
                  style={{ flex: 1, padding: '16px', border: '2px solid #e2e8f0', background: '#fff', borderRadius: '12px', fontWeight: '700', fontSize: '15px', cursor: 'pointer', color: '#64748b', transition: 'background 0.15s' }}
                  onMouseEnter={e=>e.currentTarget.style.background='#f8fafc'} onMouseLeave={e=>e.currentTarget.style.background='#fff'}
                >
                  Annuler
                </button>
                <button type="submit" disabled={fbIsSubmittingGroup}
                  style={{ flex: 2, padding: '16px', background: 'linear-gradient(135deg, #1877f2, #0d5abf)', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: '700', fontSize: '15px', cursor: 'pointer', opacity: fbIsSubmittingGroup ? 0.7 : 1, boxShadow: '0 8px 24px rgba(24,119,242,0.3)', transition: 'transform 0.15s' }}
                  onMouseEnter={e => !fbIsSubmittingGroup && (e.currentTarget.style.transform = 'translateY(-2px)')}
                  onMouseLeave={e => !fbIsSubmittingGroup && (e.currentTarget.style.transform = 'translateY(0)')}
                >
                  {fbIsSubmittingGroup ? 'Ajout en cours...' : 'Enregistrer le groupe'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Confirmation d'action */}
      {confirmAction && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)' }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmAction(null); }}
        >
          <div style={{ background: '#fff', borderRadius: '24px', padding: '40px', width: '100%', maxWidth: '420px', boxShadow: '0 24px 64px rgba(0,0,0,0.3)', animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)', textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>
              {confirmAction.type === 'validate' ? '✅' : '🚫'}
            </div>
            <h2 style={{ fontSize: '20px', fontWeight: '800', color: '#1e293b', margin: '0 0 12px 0' }}>
              {confirmAction.type === 'validate' ? 'Confirmer la validation' : 'Confirmer le rejet'}
            </h2>
            <p style={{ color: '#475569', fontSize: '15px', lineHeight: '1.5', margin: '0 0 32px 0' }}>
              Êtes-vous sûr de vouloir {confirmAction.type === 'validate' ? 'valider' : 'rejeter'} le groupe<br/>
              <strong style={{ color: '#1e293b' }}>{confirmAction.groupName || 'sans nom'}</strong> ?
            </p>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button type="button" onClick={() => setConfirmAction(null)}
                style={{ flex: 1, padding: '14px', border: '2px solid #e2e8f0', background: '#fff', borderRadius: '12px', fontWeight: '700', fontSize: '15px', cursor: 'pointer', color: '#64748b', transition: 'background 0.15s' }}
                onMouseEnter={e=>e.currentTarget.style.background='#f8fafc'} onMouseLeave={e=>e.currentTarget.style.background='#fff'}
              >
                Annuler
              </button>
              <button type="button" onClick={processConfirmAction}
                style={{ flex: 1, padding: '14px', background: confirmAction.type === 'validate' ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'linear-gradient(135deg, #ef4444, #dc2626)', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: '700', fontSize: '15px', cursor: 'pointer', boxShadow: confirmAction.type === 'validate' ? '0 8px 24px rgba(34,197,94,0.3)' : '0 8px 24px rgba(239,68,68,0.3)', transition: 'transform 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
              >
                Oui, {confirmAction.type === 'validate' ? 'Valider' : 'Rejeter'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OVERLAY ET SIDEBAR POUR LES STATS DU GROUPE */}
      {isSidebarOpen && sidebarGroup && (
        <>
          <div 
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 99990 }}
            onClick={() => setIsSidebarOpen(false)}
          />
          
          <div 
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, width: '450px', backgroundColor: '#f1f5f9',
              boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', zIndex: 99991, display: 'flex', flexDirection: 'column',
              animation: 'slideInRight 0.3s forwards'
            }}
          >
            <div style={{ padding: '24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#1e293b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>📈</span> Stats de Scraping
                </h2>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px', maxWidth: '300px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {sidebarGroup.group_name || sidebarGroup.group_id}
                </div>
              </div>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                style={{ background: '#f1f5f9', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#64748b', width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >✕</button>
            </div>

            <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              {isLoadingSidebar ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#64748b', fontWeight: '600' }}>Chargement des données...</div>
              ) : sidebarData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>Aucune donnée disponible pour ce groupe.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  
                  {/* Résumé et Actions */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#e2e8f0', padding: '16px', borderRadius: '12px' }}>
                    <div>
                      <div style={{ fontSize: '12px', color: '#475569', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.5px' }}>Moyenne journalière</div>
                      <div style={{ fontSize: '24px', fontWeight: '800', color: '#0f172a' }}>
                        {sidebarData.length > 0 ? Math.round(sidebarData.reduce((acc, row) => acc + parseInt(row.processed_count || 0), 0) / sidebarData.length) : 0} <span style={{ fontSize: '14px', fontWeight: '600', color: '#64748b' }}>biens/j</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '600', marginTop: '2px' }}>
                        sur {sidebarData.length > 0 ? Math.round(sidebarData.reduce((acc, row) => acc + parseInt(row.post_count || 0), 0) / sidebarData.length) : 0} posts/j au total
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setConfirmAction({ type: 'reject', groupId: sidebarGroup.group_id, groupName: sidebarGroup.group_name || sidebarGroup.group_id });
                        setIsSidebarOpen(false);
                      }}
                      style={{ background: '#fee2e2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '8px', padding: '10px 16px', fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#fecaca'}
                      onMouseLeave={e => e.currentTarget.style.background = '#fee2e2'}
                      title="Rejeter ce groupe (il ne sera plus traité)"
                    >
                      🚫 Rejeter le groupe
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {sidebarData.map((row, idx) => (
                    <div key={idx} style={{ background: '#fff', padding: '16px 20px', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid #e2e8f0' }}>
                      <div>
                        <div style={{ fontWeight: '700', color: '#1e293b', fontSize: '15px', textTransform: 'capitalize' }}>
                          {row.day ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(row.day)) : 'Date inconnue'}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '24px', fontWeight: '800', color: '#1877f2', lineHeight: '1' }}>
                          {row.processed_count}
                        </div>
                        <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.5px', marginTop: '4px' }}>biens créés</div>
                        <div style={{ fontSize: '10px', color: '#cbd5e1', fontWeight: '600', marginTop: '2px' }}>sur {row.post_count} posts</div>
                      </div>
                    </div>
                  ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

    </div>
  );
}
