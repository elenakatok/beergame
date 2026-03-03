import React from "react";
import { ROLE_COLORS, ROLE_LABELS } from "./chartConstants";
import { TeamRoleStdDevRow } from "../../logic/endgameAnalytics";

interface TeamRoleStdDevGroupedBarChartProps {
  rows: TeamRoleStdDevRow[];
}

const ROLE_STDDEV_KEYS = [
  { role: "retailer" as const, key: "retailerStdDev" as const },
  { role: "wholesaler" as const, key: "wholesalerStdDev" as const },
  { role: "distributor" as const, key: "distributorStdDev" as const },
  { role: "factory" as const, key: "factoryStdDev" as const },
];

const TeamRoleStdDevGroupedBarChart: React.FC<TeamRoleStdDevGroupedBarChartProps> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="empty-state">No completed team history is available yet.</div>;
  }

  const barWidth = 14;
  const barGap = 4;
  const groupGap = 18;
  const groupWidth = ROLE_STDDEV_KEYS.length * barWidth + (ROLE_STDDEV_KEYS.length - 1) * barGap;
  const paddingLeft = 54;
  const paddingRight = 18;
  const paddingTop = 16;
  const paddingBottom = 64;
  const width = Math.max(640, paddingLeft + paddingRight + rows.length * groupWidth + (rows.length - 1) * groupGap);
  const height = 280;
  const plotHeight = height - paddingTop - paddingBottom;
  const allValues = rows.flatMap((row) => ROLE_STDDEV_KEYS.map((roleRow) => row[roleRow.key]));
  const maxValue = Math.max(1, ...allValues);
  const yMax = Math.ceil(maxValue);
  const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];

  return (
    <div className="stddev-chart">
      <div className="stddev-chart-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Standard deviation of orders by role for each team"
        >
          <line
            x1={paddingLeft}
            y1={height - paddingBottom}
            x2={width - paddingRight}
            y2={height - paddingBottom}
            stroke="#b4b5b5"
            strokeWidth={0.8}
          />
          <line
            x1={paddingLeft}
            y1={paddingTop}
            x2={paddingLeft}
            y2={height - paddingBottom}
            stroke="#b4b5b5"
            strokeWidth={0.8}
          />

          {yTicks.map((tick, index) => {
            const y = paddingTop + (1 - tick / yMax) * plotHeight;
            return (
              <g key={index}>
                <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="#ececec" strokeWidth={0.8} />
                <text x={paddingLeft - 8} y={y + 4} fontSize={10} textAnchor="end" fill="#666">
                  {tick.toFixed(2)}
                </text>
              </g>
            );
          })}

          {rows.map((row, teamIndex) => {
            const groupX = paddingLeft + teamIndex * (groupWidth + groupGap);
            const centerX = groupX + groupWidth / 2;
            return (
              <g key={row.teamId}>
                {ROLE_STDDEV_KEYS.map((roleRow, roleIndex) => {
                  const value = row[roleRow.key];
                  const normalized = yMax === 0 ? 0 : value / yMax;
                  const barHeight = normalized * plotHeight;
                  const x = groupX + roleIndex * (barWidth + barGap);
                  const y = height - paddingBottom - barHeight;
                  return (
                    <rect
                      key={`${row.teamId}-${roleRow.role}`}
                      x={x}
                      y={y}
                      width={barWidth}
                      height={Math.max(0, barHeight)}
                      fill={ROLE_COLORS[roleRow.role]}
                      rx={2}
                    />
                  );
                })}
                <text x={centerX} y={height - paddingBottom + 16} fontSize={10} textAnchor="middle" fill="#444">
                  {row.teamName}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="line-chart-legend">
        {ROLE_STDDEV_KEYS.map((roleRow) => (
          <div key={roleRow.role} className="line-chart-legend-item">
            <span className="line-chart-legend-swatch" style={{ backgroundColor: ROLE_COLORS[roleRow.role] }} />
            <span>{ROLE_LABELS[roleRow.role]}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TeamRoleStdDevGroupedBarChart;
