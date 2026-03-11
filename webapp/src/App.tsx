import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, fetchWithCsrf } from './api';
import AdminLayout from './layouts/AdminLayout';
import DashboardPage from './pages/app/dashboard/DashboardPage';
import ConfigPage from './pages/app/config/ConfigPage';
import WizardPage from './pages/wizard/WizardPage';
import { navigate, usePathname } from './router';

const DASHBOARD_ROUTE = '/app/dashboard';
const CONFIG_ROUTE = '/app/config';
const LOGIN_ROUTE = '/login';
const WIZARD_ROUTE = '/wizard';

function resolveRoute(pathname: string, authenticated: boolean): string {
  if (!authenticated) return pathname === LOGIN_ROUTE ? pathname : LOGIN_ROUTE;
  if (pathname === DASHBOARD_ROUTE || pathname === CONFIG_ROUTE || pathname === WIZARD_ROUTE) return pathname;
  return DASHBOARD_ROUTE;
}

function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en';

  return (
    <div className="language-switch" aria-label={t('languageLabel')}>
      <button type="button" className={`language-btn ${locale === 'zh' ? 'active' : ''}`} onClick={() => i18n.changeLanguage('zh')}>
        {t('languageZh')}
      </button>
      <button type="button" className={`language-btn ${locale === 'en' ? 'active' : ''}`} onClick={() => i18n.changeLanguage('en')}>
        {t('languageEn')}
      </button>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');

  const refreshBootstrap = async (options?: { silent?: boolean }) => {
    try {
      if (!options?.silent) {
        setLoading(true);
      }
      setError('');
      await api('/api/config/current');
      setNeedsLogin(false);
    } catch (err: any) {
      const message = err.message || t('loadFailed');
      if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
        setNeedsLogin(true);
        return;
      }
      setError(message);
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void refreshBootstrap();
  }, []);

  useEffect(() => {
    if (loading) return;
    const target = resolveRoute(pathname, !needsLogin);
    if (target !== pathname) navigate(target, { replace: true });
  }, [loading, needsLogin, pathname]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setLoading(true);
      setError('');
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput }),
      });
      if (!res.ok) throw new Error(t('invalidToken'));
      await refreshBootstrap();
      navigate(DASHBOARD_ROUTE, { replace: true });
    } catch (err: any) {
      setError(err.message || t('invalidToken'));
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchWithCsrf('/auth/logout', { method: 'POST' });
    } finally {
      setNeedsLogin(true);
      setTokenInput('');
      setError('');
      navigate(LOGIN_ROUTE, { replace: true });
    }
  };

  const handleOpenConfig = () => {
    navigate(pathname === WIZARD_ROUTE ? DASHBOARD_ROUTE : WIZARD_ROUTE);
  };

  if (loading && !needsLogin) {
    return (
      <div className="fade-in auth-container" style={{ marginTop: '20vh' }}>
        <LanguageSwitch />
        <div className="glass-card loading-card">{t('loadingDashboard')}</div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="fade-in auth-container" style={{ marginTop: '10vh' }}>
        <LanguageSwitch />
        <div className="glass-card login-card login-shell">
          <div className="login-badge">{t('protectedAccess')}</div>
          <h1 className="title">{t('dashboardTitle')}</h1>
          <p className="subtitle">{t('dashboardAccessPrompt')}</p>
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label className="form-label">{t('accessToken')}</label>
              <input
                autoFocus
                type="password"
                className="form-input"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder={t('accessTokenPlaceholder')}
              />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: '1rem' }} disabled={loading}>
              {loading ? t('authenticating') : t('login')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isConfigRoute = pathname === CONFIG_ROUTE || pathname === WIZARD_ROUTE;

  return (
    <AdminLayout
      pathname={pathname}
      actions={
        <>
          <LanguageSwitch />
          <button type="button" className="btn btn-outline" onClick={handleOpenConfig}>
            {isConfigRoute ? t('backToDashboard') : t('openWizard')}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => void handleLogout()}>
            {t('logout')}
          </button>
        </>
      }
    >
      {pathname === CONFIG_ROUTE ? <ConfigPage onConfigSaved={() => void refreshBootstrap()} /> : null}
      {pathname === WIZARD_ROUTE ? <WizardPage onConfigSaved={() => void refreshBootstrap({ silent: true })} /> : null}
      {pathname === DASHBOARD_ROUTE ? <DashboardPage /> : null}
    </AdminLayout>
  );
}
