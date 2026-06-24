import { Component } from 'solid-js';
import styles from './IoUDetail.module.css';

interface Props {
  intersectionPx: number;
  unionPx: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

const IoUDetail: Component<Props> = (props) => {
  const pct = () => props.unionPx > 0 ? Math.round(props.intersectionPx / props.unionPx * 100) : 0;

  return (
    <div class={styles.iouDetail}>
      <div>∩ Intersection: <strong>{fmt(props.intersectionPx)} px²</strong></div>
      <div>∪ Union: <strong>{fmt(props.unionPx)} px²</strong></div>
      <div class={styles.iouDetailResult}>
        IoU = {fmt(props.intersectionPx)} / {fmt(props.unionPx)} = <strong>{pct()}%</strong>
      </div>
    </div>
  );
};

export default IoUDetail;
