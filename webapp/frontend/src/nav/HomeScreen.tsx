import { Component } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import styles from './HomeScreen.module.css';

const HomeScreen: Component = () => {
  const nav = useNavigate();
  return (
  <div class={styles.tiles}>
    <button class={styles.tile} onClick={() => nav('/manage')}>
      <strong>Manage Sets</strong>
      <span>Upload, rename, delete</span>
    </button>
    <button class={styles.tile} onClick={() => nav('/merge')}>
      <strong>Merge Sets</strong>
      <span>Group overlapping annotations</span>
    </button>
    <button class={styles.tile} onClick={() => nav('/analyze')}>
      <strong>Analyze</strong>
      <span>Agreement map</span>
    </button>
    <button class={`${styles.tile} ${styles.tileSoon}`} disabled>
      <strong>Re-annotate</strong>
      <span>Coming soon</span>
    </button>
    <button class={`${styles.tile} ${styles.tileWide}`} onClick={() => nav('/train')}>
      <strong>Train</strong>
      <span>Practice annotation</span>
    </button>
  </div>
  );
};

export default HomeScreen;
