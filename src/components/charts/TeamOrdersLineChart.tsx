import React from "react";
import { ROLES, TeamState } from "../../logic/gameModel";
import { ROLE_COLORS, ROLE_LABELS } from "./chartConstants";

interface TeamOrdersLineChartProps {
  team: TeamState;
  maxY?: number;
  width?: number;
  height?: number;
}

const TeamOrdersLineChart: React.FC<TeamOrdersLineChartProps> = ({
  team,
  maxY = 25,
  width = 360,
  height = 160,
}) => {
  const series = ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    values: (team.stages[role].history || []).map((h) => h.orderPlaced ?? 0),
  }));

  const maxWeeks = series.reduce((max, s) => Math.max(max, s.values.length), 1);
  const paddingLeft = 32;
  const paddingRight = 10;
  const paddingTop = 10;
  const paddingBottom = 24;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const getX = (weekIndex: number) => {
    if (maxWeeks <= 1) {
      return paddingLeft + plotWidth / 2;
    }
    const t = weekIndex / (maxWeeks - 1);
    return paddingLeft + t * plotWidth;
  };

  const getY = (value: number) => {
    const val = Math.max(value, 0);
    const t = val / maxY;
    return paddingTop + (1 - t) * plotHeight;
  };

  return (
    <div className="line-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Orders over time for ${team.name}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <line
          x1={paddingLeft}
          y1={height - paddingBottom}
          x2={width - paddingRight}
          y2={height - paddingBottom}
          stroke="#aaa"
          strokeWidth={0.5}
        />
        <line
          x1={paddingLeft}
          y1={paddingTop}
          x2={paddingLeft}
          y2={height - paddingBottom}
          stroke="#aaa"
          strokeWidth={0.5}
        />

        <text x={paddingLeft - 6} y={height - paddingBottom + 10} fontSize={9} textAnchor="end" fill="#555">
          0
        </text>
        <text x={paddingLeft - 6} y={paddingTop + 3} fontSize={9} textAnchor="end" fill="#555">
          {maxY}
        </text>

        <text x={getX(0)} y={height - 6} fontSize={9} textAnchor="middle" fill="#555">
          1
        </text>
        <text x={getX(maxWeeks - 1)} y={height - 6} fontSize={9} textAnchor="middle" fill="#555">
          {maxWeeks}
        </text>

        {series.map((s) => {
          if (s.values.length === 0) return null;
          const d = s.values
            .map((v, idx) => {
              const x = getX(idx);
              const y = getY(v);
              return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
            })
            .join(" ");
          return <path key={s.role} d={d} fill="none" stroke={ROLE_COLORS[s.role]} strokeWidth={1.5} />;
        })}

        {series.map((s) =>
          s.values.map((v, idx) => {
            const x = getX(idx);
            const y = getY(v);
            return (
              <circle key={`${s.role}-${idx}`} cx={x} cy={y} r={2} fill={ROLE_COLORS[s.role]}>
                <title>{`${s.label} Week ${idx + 1}: ${v}`}</title>
              </circle>
            );
          })
        )}
      </svg>

      <div className="line-chart-legend">
        {series.map((s) => (
          <div key={s.role} className="line-chart-legend-item">
            <span className="line-chart-legend-swatch" style={{ backgroundColor: ROLE_COLORS[s.role] }} />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TeamOrdersLineChart;
