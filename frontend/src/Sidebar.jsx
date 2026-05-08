import { useState } from 'react';

function Sidebar({ currentPage, onNavigate }) {
  const [collapsed, setCollapsed] = useState(false);

  const links = [
    { id: 'discovery', label: 'Master Discovery', icon: '🔍' },
    { id: 'crud', label: 'CRUD Operations', icon: '⚙️' },
    { id: 'template-workflow', label: 'Template Workflow', icon: '🔗' },
    { id: 'mandatory', label: 'Mandatory Fields', icon: '✅' },
    { id: 'duplicate-check', label: 'Duplicate Check', icon: '🔄' },
    { id: 'compliance', label: 'Compliance Suite', icon: '🛡️' },
    { id: 'recordings', label: 'Recordings', icon: '🎥' },
    { id: 'test-report', label: 'Test Report', icon: '🧾' },
  ];

  return (
    <nav className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="sidebar-header">
        <span className="sidebar-brand">{collapsed ? 'QF' : 'TestHive'}</span>
        <button className="sidebar-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '▶' : '◀'}
        </button>
      </div>
      <ul className="sidebar-links">
        {links.map((link) => (
          <li key={link.id}>
            <button
              className={`sidebar-link ${currentPage === link.id ? 'active' : ''}`}
              onClick={() => onNavigate(link.id)}
              title={link.label}
            >
              <span className="sidebar-icon">{link.icon}</span>
              {!collapsed && <span className="sidebar-label">{link.label}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default Sidebar;
