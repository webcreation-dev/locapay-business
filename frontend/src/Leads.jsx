import React from 'react';

const Leads = () => {
    return (
        <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
            <iframe 
                src="/leads-dashboard/" 
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="LocaPay Leads"
            />
        </div>
    );
};

export default Leads;
