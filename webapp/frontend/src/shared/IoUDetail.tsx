import { Component } from 'solid-js';
import { t } from '../i18n/catalog';
import * as styles from './IoUDetail.css';

interface Props {
  intersectionPx: number;
  unionPx: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

const IoUDetail: Component<Props> = (props) => {
  const pct = () => props.unionPx > 0 ? Math.round(props.intersectionPx / props.unionPx * 100) : 0;

  return (
    <div class={styles.iouDetail}>
      <div>
        {t('iou.intersection')} <strong>{fmt(props.intersectionPx)} {t('iou.pxUnit')}</strong>
      </div>
      <div>
        {t('iou.union')} <strong>{fmt(props.unionPx)} {t('iou.pxUnit')}</strong>
      </div>
      <div class={styles.iouDetailResult}>
        {t('iou.formula')} {fmt(props.intersectionPx)} / {fmt(props.unionPx)} = <strong>{t('iou.result', { pct: pct() })}</strong>
      </div>
    </div>
  );
};

export default IoUDetail;
