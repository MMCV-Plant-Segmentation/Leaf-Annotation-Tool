import { Component } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { t } from '../i18n/catalog';
import * as styles from './HomeScreen.css';

const HomeScreen: Component = () => {
  const nav = useNavigate();
  return (
  <div class={styles.tiles}>
    <button class={styles.tile} onClick={() => nav('/manage')}>
      <strong>{t('home.manageTitle')}</strong>
      <span>{t('home.manageSub')}</span>
    </button>
    <button class={styles.tile} onClick={() => nav('/merge')}>
      <strong>{t('home.mergeTitle')}</strong>
      <span>{t('home.mergeSub')}</span>
    </button>
    <button class={styles.tile} onClick={() => nav('/analyze')}>
      <strong>{t('home.analyzeTitle')}</strong>
      <span>{t('home.analyzeSub')}</span>
    </button>
    <button class={styles.tile} onClick={() => nav('/projects')}>
      <strong>{t('home.projectsTitle')}</strong>
      <span>{t('home.projectsSub')}</span>
    </button>
    <button class={`${styles.tile} ${styles.tileWide}`} onClick={() => nav('/train')}>
      <strong>{t('home.trainTitle')}</strong>
      <span>{t('home.trainSub')}</span>
    </button>
  </div>
  );
};

export default HomeScreen;
