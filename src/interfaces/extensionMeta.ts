interface TopologyStub {
  types: {
    displayName: string;
    name: string;
    rules: {
      requiredDimensions?: {
        key: string;
        valuePattern?: any;
      }[];
      sources: {
        sourceType: string;
        condition: string;
      }[];
      attributes: {
        key: string;
        displayName: string;
        pattern: string;
      }[];
    }[];
  }[];
  relationships: RelationshipStub[];
}

interface RelationshipStub {
  fromType: string;
  toType: string;
  typeOfRelation: string;
  sources: any[];
}

interface DimensionStub {
  key: string;
  value: string;
  filter?: string;
}
interface MetricStub {
  key: string;
  value: string;
  type?: string;
  featureSet?: string;
}

interface DatasourceGroup {
  featureSet?: string;
  dimensions?: DimensionStub[];
  metrics?: MetricStub[];
  subgroups?: {
    featureSet?: string;
    dimensions?: DimensionStub[];
    metrics: MetricStub[];
  }[];
}

interface MetricMetadata {
  key: string;
  metadata: {
    displayName: string;
    description: string;
    unit: string;
    tags: string[];
  };
}

interface VarStub {
  type: string;
  displayName: string;
  id: string;
}

interface ScreenStub {
  entityType: string;
  propertiesCard?: any;
  listSettings?: any;
  detailsSettings?: any;
  entitiesListCards?: any[];
  chartsCards?: ChartsCardStub[];
  messageCards?: any[];
}

interface ChartsCardStub {
  key: string;
  charts: ChartStub[];
}

interface ChartStub {
  graphChartConfig?: GraphConfigStub;
  pieChartConfig?: SingleMetricConfig;
  singleValueConfig?: SingleMetricConfig;
}

interface ChartConfigStub {
  metrics: { metricSelector: string }[];
  visualization: any;
}

interface GraphConfigStub {
  metrics: { metricSelector: string }[];
}

interface SingleMetricConfig {
  metric: { metricSelector: string };
}

interface ExtensionStub {
  name: string;
  version: string;
  minDynatraceVersion: string;
  alerts: { path: string }[];
  dashboards: { path: string }[];
  snmp?: DatasourceGroup[];
  wmi?: DatasourceGroup[];
  prometheus?: DatasourceGroup[];
  sql?: DatasourceGroup[];
  metrics: MetricMetadata[];
  topology: TopologyStub;
  vars?: VarStub[];
  screens?: ScreenStub[];
}
