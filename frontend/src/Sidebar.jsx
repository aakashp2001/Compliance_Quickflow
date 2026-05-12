import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  IconBrandLogo,
  IconChevronCollapse,
  IconChevronExpand,
  IconCrud,
  IconDuplicate,
  IconMandatory,
  IconRecording,
  IconReport,
  IconSearchDb,
  IconWorkflow,
  IconCompliance,
} from './sidebarIcons';

const BRAND_NAME = 'TestHive';

const NAV_LINKS = [
  { path: '/master-discovery', label: 'Master Discovery', Icon: IconSearchDb },
  { path: '/crud-operations', label: 'CRUD Operations', Icon: IconCrud },
  { path: '/template-workflow', label: 'Template Workflow', Icon: IconWorkflow },
  { path: '/mandatory-fields', label: 'Mandatory Fields', Icon: IconMandatory },
  { path: '/duplicate-check', label: 'Duplicate Check', Icon: IconDuplicate },
  { path: '/compliance', label: 'Compliance Suite', Icon: IconCompliance },
  { path: '/recordings', label: 'Recordings', Icon: IconRecording },
  { path: '/test-report', label: 'Test Report', Icon: IconReport },
];

function Sidebar() {
  const [collapsed, setCollapsed] = useState(true);

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
    <nav className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Main navigation">
      <div className="sidebar-header">
        <div className="sidebar-brand-lockup" title={BRAND_NAME}>
          <span className="sidebar-logo-mark">
            <IconBrandLogo size={collapsed ? 26 : 30} />
          </span>
          {!collapsed && <span className="sidebar-wordmark">{BRAND_NAME}</span>}
        </div>
      </div>
      <ul className="sidebar-links">
        {NAV_LINKS.map(({ path, label, Icon }) => (
          <li key={path}>
            <NavLink
              to={path}
              end
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              title={label}
            >
              <span className="sidebar-icon" aria-hidden>
                <Icon />
              </span>
              {!collapsed && <span className="sidebar-label">{label}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {collapsed ? <IconChevronExpand /> : <IconChevronCollapse />}
        </button>
      </div>
    </nav>
  );
}

export default Sidebar;
