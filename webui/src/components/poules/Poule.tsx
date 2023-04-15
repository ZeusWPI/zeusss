import { fetchPouleMatches } from "@/lib/api";
import { Card, Center, Flex, Group, Loader, NumberInput, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";

declare type PouleProps = {
  poule: API.Poule;
  readonly?: boolean;
}

export const Poule = ({poule, readonly}: PouleProps) => {
  const {isLoading, isError, error, data: matches} = useQuery({
    queryKey: ["poule", "match", poule.id],
    queryFn: () => fetchPouleMatches(poule.id),
    staleTime: 30000,
  });

  const sortedTeams = useMemo(() => poule.teams.sort((t1, t2) => (t2?.score ?? 0) - (t1?.score ?? 0)), [poule.teams]);

  const updateTeamScore = async (matchId: number, teamId: number, score: number) => {
    if (Number.isNaN(score)) {
      return;
    }
    const resp = await fetch(`/api/poules/${poule.id}/matches/${matchId}/teams/${teamId}`, {
      method: "PATCH",
      body: JSON.stringify({
        score
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      notifications.show({
        message: `Failed to update team score, ${teamId} - ${matchId}: ${data?.message ?? resp.statusText}`,
        color: "red",
      });
      return;
    };
  };

  const updateMatchDate = async (matchId: number, playDate: Date) => {
    if (playDate.toString() === "Invalid Date") return;
    const resp = await fetch(`/api/poules/${poule.id}/matches/${matchId}`, {
      method: "PATCH",
      body: JSON.stringify({
        date: playDate.toString(),
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      notifications.show({
        message: `Failed to update match date, ${matchId}: ${data?.message ?? resp.statusText}`,
        color: "red",
      });
      return;
    };
  };

  return (
    <Card shadow="sm" padding="lg" m='xs' radius="md" withBorder w={"19rem"} style={{overflow: "visible"}}>
      <Card.Section inheritPadding py="xs" withBorder>
        <Title order={4}>{poule.name}</Title>
      </Card.Section>
      <Card.Section inheritPadding py="xs" withBorder>
        <SimpleGrid cols={1} spacing="xs" verticalSpacing="xs">
          {sortedTeams.map(t => (
            <Paper key={t.id} shadow="xs" p='xs'>
              <Flex align="center" justify="space-between">
                <Text className="text-cutoff">{t.name}</Text>
                <Text weight={"semibold"}>{t.score}</Text>
              </Flex>
            </Paper>
          ))}
        </SimpleGrid>
      </Card.Section>
      <Card.Section inheritPadding py="xs" withBorder>
        {isLoading && (
          <Center>
            <Stack spacing={"xs"}>
              <Center>
                <Loader />
              </Center>
              <Text italic>Loading poule matches</Text>
            </Stack>
          </Center>
        )}
        {isError && (
          <Center>
            <Stack spacing={"xs"}>
              <Center>
                <AlertTriangle color="orange" />
              </Center>
              <Text>Er is iets misgelopen bij het laden van de matches</Text>
            </Stack>
          </Center>
        )}
        {matches && matches.map(match => (
          <Paper shadow={"sm"} p="sm" key={`match-${match.id}`}>
            {match.teams.map(mTeam => (
              <Group key={`match-${match.id}-team-${mTeam.id}`} position={"apart"}>
                <Text>
                  {mTeam.name}
                </Text>
                {readonly ? (
                  <Text weight={"semibold"}>
                    {mTeam.score}
                  </Text>
                ): (
                  <NumberInput
                    min={0}
                    placeholder="score"
                    value={mTeam.score ?? 0}
                    onBlur={(v) => updateTeamScore(match.id, mTeam.id, Number(v.currentTarget.value))}
                  />
                )}
              </Group>
            ))}
            {!readonly && (
              <DateTimePicker
                label="Match play moment"
                value={new Date(match.date ?? Date.now())}
                onDateChange={date => updateMatchDate(match.id, date)}
              />
            )}
          </Paper>
        ))}
      </Card.Section>
    </Card>
  );
};
