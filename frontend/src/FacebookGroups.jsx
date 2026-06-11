import React, { useState, useEffect, useCallback } from 'react';
import './index.css';

export default function FacebookGroups() {
  const [fbGroups, setFbGroups] = useState([]);
  const [fbIsLoadingGroups, setFbIsLoadingGroups] = useState(false);
  const [fbIsSubmittingGroup, setFbIsSubmittingGroup] = useState(false);
  const [fbGroupsAddModal, setFbGroupsAddModal] = useState(false);
  const [fbAddUrl, setFbAddUrl] = useState('');
  const [fbAddName, setFbAddName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [toast, setToast] = useState(null);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // ─── EFFACER TOAST APRÈS 8s ───────────────────────────
  useEffect(() => {
    if (toast && !toast.persistent) {
      const id = setTimeout(() => setToast(null), 8000);
      return () => clearTimeout(id);
    }
  }, [toast]);

  const fetchFbGroups = useCallback(async (showLoader = false) => {
    if (showLoader) setFbIsLoadingGroups(true);
    try {
      const res = await fetch('/api/facebook/groups');
      const data = await res.json();
      setFbGroups(data);
    } catch (e) {
      console.error('fetchFbGroups error', e);
    } finally {
      if (showLoader) setFbIsLoadingGroups(false);
    }
  }, []);

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
        fetchFbGroups();
      } else {
        throw new Error(data.errors?.[0]?.error || data.error || 'Erreur inconnue');
      }
    } catch (e) {
      setToast({ message: `❌ ${e.message}`, type: 'error' });
    } finally {
      setFbIsSubmittingGroup(false);
    }
  };

  // Pagination logic
  const totalPages = Math.ceil(fbGroups.length / itemsPerPage);
  const currentGroups = fbGroups.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const totalPosts = fbGroups.reduce((acc, g) => acc + parseInt(g.total_posts || 0), 0);
  const totalProcessed = fbGroups.reduce((acc, g) => acc + parseInt(g.processed || 0), 0);
  const totalPending = fbGroups.reduce((acc, g) => acc + parseInt(g.pending || 0), 0);

  return (
    <div style={{ fontFamily: 'var(--font-family)', display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#f1f5f9' }}>
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
          <button
            onClick={() => setFbGroupsAddModal(true)}
            style={{ background: '#fff', color: '#1877f2', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', transition: 'transform 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
            onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
          >
            <span style={{ fontSize: '18px' }}>+</span> Ajouter un groupe
          </button>
        </div>

        {/* Stats Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>Groupes Suivis</div>
            <div style={{ fontSize: '28px', fontWeight: '700' }}>{fbGroups.length}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>Total Posts</div>
            <div style={{ fontSize: '28px', fontWeight: '700' }}>{totalPosts}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.2)' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8, marginBottom: '8px', fontWeight: '600' }}>Biens Créés</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: '#86efac' }}>{totalProcessed}</div>
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
          <div style={{ background: '#fff', borderRadius: '16px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: 'linear-gradient(90deg, #f8faff 0%, #f1f5ff 100%)', borderBottom: '2px solid #e2e8f0' }}>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: '700', color: '#475569', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>ID Groupe</th>
                  <th style={{ padding: '16px 24px', textAlign: 'left', fontWeight: '700', color: '#475569', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nom du Groupe</th>
                  <th style={{ padding: '16px 24px', textAlign: 'center', fontWeight: '700', color: '#475569', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Posts récupérés</th>
                  <th style={{ padding: '16px 24px', textAlign: 'center', fontWeight: '700', color: '#475569', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Statut</th>
                  <th style={{ padding: '16px 24px', textAlign: 'center', fontWeight: '700', color: '#475569', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {currentGroups.map((group, idx) => (
                  <tr key={group.group_id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 0 ? '#fff' : '#fafbff', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f0f7ff'}
                    onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? '#fff' : '#fafbff'}
                  >
                    {/* ID */}
                    <td style={{ padding: '16px 24px', whiteSpace: 'nowrap' }}>
                      <span
                        title={group.group_id}
                        style={{ fontFamily: 'monospace', fontSize: '13px', background: '#f1f5f9', color: '#475569', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', border: '1px solid #e2e8f0' }}
                        onClick={() => { navigator.clipboard.writeText(group.group_id); setToast({ message: '📋 ID copié !', type: 'success' }); }}
                      >
                        {group.group_id.length > 16 ? group.group_id.substring(0, 14) + '…' : group.group_id}
                      </span>
                    </td>

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

                    {/* Nb de posts */}
                    <td style={{ padding: '16px 24px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontWeight: '700', fontSize: '18px', color: '#1e293b' }}>{parseInt(group.total_posts) || 0}</span>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
                          {parseInt(group.processed) > 0 && <span style={{ fontSize: '10px', background: '#dcfce7', color: '#16a34a', padding: '2px 6px', borderRadius: '6px', fontWeight: '700' }}>✅ {group.processed}</span>}
                          {parseInt(group.pending) > 0 && <span style={{ fontSize: '10px', background: '#fef3c7', color: '#d97706', padding: '2px 6px', borderRadius: '6px', fontWeight: '700' }}>⏳ {group.pending}</span>}
                          {parseInt(group.errors) > 0 && <span style={{ fontSize: '10px', background: '#fee2e2', color: '#dc2626', padding: '2px 6px', borderRadius: '6px', fontWeight: '700' }}>⚠️ {group.errors}</span>}
                        </div>
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
                        {/* Voir sur Facebook */}
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

                        {/* Valider */}
                        {group.is_validated !== true && (
                          <button
                            onClick={() => handleValidateGroup(group.group_id)}
                            style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s', boxShadow: '0 2px 8px rgba(34,197,94,0.3)' }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'scale(1.02)'; }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1)'; }}
                            title="Valider ce groupe"
                          >
                            ✅ Valider
                          </button>
                        )}

                        {/* Rejeter */}
                        {group.is_validated !== false && (
                          <button
                            onClick={() => handleRejectGroup(group.group_id)}
                            style={{ background: 'linear-gradient(135deg, #f87171, #dc2626)', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 14px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s', boxShadow: '0 2px 8px rgba(220,38,38,0.3)' }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'scale(1.02)'; }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1)'; }}
                            title="Rejeter ce groupe"
                          >
                            🚫 Rejeter
                          </button>
                        )}

                        {/* Reset si déjà décidé */}
                        {group.is_validated !== null && (
                          <button
                            onClick={() => handleResetGroupValidation(group.group_id)}
                            style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', transition: 'all 0.15s' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#e2e8f0'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = '#f1f5f9'; }}
                            title="Annuler la décision"
                          >
                            ↩️
                          </button>
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
              <button onClick={() => setFbGroupsAddModal(false)} style={{ background: '#f1f5f9', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#64748b', padding: '8px', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background='#e2e8f0'} onMouseLeave={e=>e.currentTarget.style.background='#f1f5f9'}>✕</button>
            </div>
            <form onSubmit={handleAddGroupFromModal} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '700', color: '#475569', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>URL ou ID du Groupe *</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={fbAddUrl}
                  onChange={e => setFbAddUrl(e.target.value)}
                  placeholder="https://www.facebook.com/groups/123456789/"
                  style={{ width: '100%', padding: '14px 16px', border: '2px solid #e2e8f0', borderRadius: '12px', fontSize: '15px', outline: 'none', transition: 'all 0.2s', boxSizing: 'border-box' }}
                  onFocus={e => { e.target.style.borderColor = '#1877f2'; e.target.style.boxShadow = '0 0 0 4px rgba(24,119,242,0.1)'; }}
                  onBlur={e => { e.target.style.borderColor = '#e2e8f0'; e.target.style.boxShadow = 'none'; }}
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
                <button type="button" onClick={() => setFbGroupsAddModal(false)}
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
    </div>
  );
}
