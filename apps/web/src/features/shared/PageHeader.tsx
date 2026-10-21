import type { ReactNode } from 'react';
import { Heading, Row, Stack, Text } from '../../ui';

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <Row justify="between" align="start" gap={4}>
      <Stack gap={1}>
        {eyebrow}
        <Heading>{title}</Heading>
        {subtitle && <Text tone="muted">{subtitle}</Text>}
      </Stack>
      {actions && <Row gap={2}>{actions}</Row>}
    </Row>
  );
}
