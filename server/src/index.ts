import * as dotenv from "dotenv";
dotenv.config();
import fastify from "fastify";
import { type BracketMatch, PrismaClient, PouleMatch, PouleMatchTeam, Team } from "@prisma/client";
import fastify_static from "@fastify/static";
import * as path from "path";
import { createPouleMatches, deletePouleMatchesAndTeams, matchesHaveBeenPlayed } from "./poules";
import { createBracketTree } from "./bracket";

const prisma = new PrismaClient();
const server = fastify({
  disableRequestLogging: true,
  logger: {
    level: process.env.ENV === "production" ? "info" : "debug",
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
});

server.register(fastify_static, {
  root: path.join(process.cwd(), "public"),
  prefix: "/",
  index: "index.html",
  wildcard: false,
});

server.register(
  (instance, opts, next) => {
    // GET requests
    instance.get("/teams", async (request: any, reply) => {
      if (request.query.league) {
        const teams = await prisma.team.findMany({
          where: {
            league: request.query.league,
          },
        });
        reply.send(teams);
      } else {
        const teams = await prisma.team.findMany();
        reply.send(teams);
      }
    });
    instance.get("/teams/:id", async (request: any, reply) => {
      const team = await prisma.team.findFirst({
        where: {
          id: parseInt(request.params.id),
        },
      });

      if (!team) {
        reply.code(404).send();
        return;
      }

      reply.send(team);
    });
    instance.get<{ Querystring: { league: string } }>("/poules", async (request, reply) => {
      const poules = await prisma.poule.findMany({
        select: {
          id: true,
          name: true,
          PouleMatch: {
            include: {
              PouleMatchTeam: {
                select: {
                  score: true,
                  team: {
                    select: {
                      id: true,
                      name: true,
                      league: true,
                    },
                  },
                },
                orderBy: {
                  id: "asc",
                },
              },
            },
          },
        },
        where: {
          league: request.query.league,
        },
        orderBy: {
          id: "asc",
        },
      });

      const mapped_poules = poules.map(p => {
        const poule_teams = p.PouleMatch.reduce<TeamWScore[]>((arr, match) => {
          match.PouleMatchTeam.forEach(dbTeam => {
            const team = arr.find(t => t.id === dbTeam.team.id);
            const score = dbTeam.score ?? 0;
            if (team) {
              team.score += score;
            } else {
              arr.push({ ...dbTeam.team, score });
            }
          });
          return arr;
        }, []);
        return {
          id: p.id,
          name: p.name,
          teams: poule_teams,
        };
      });

      reply.send(mapped_poules);
    });
    instance.get("/poules/:id", async (request: any, reply) => {
      type PouleTeam = {
        id: number;
        name: string;
        league: string;
      };

      type CompletePoule = {
        id: number;
        name: string;
        teams: PouleTeam[];
        matches: string;
      };

      const id_param = parseInt(request.params.id);

      const poule = await prisma.poule.findFirst({
        where: {
          id: id_param,
        },
        select: {
          id: true,
          name: true,
          PouleMatch: {
            include: {
              PouleMatchTeam: {
                include: {
                  team: {
                    select: {
                      id: true,
                      name: true,
                      league: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!poule) {
        reply.code(404).send();
        return;
      }

      const poule_teams = poule.PouleMatch.flatMap(pm => pm.PouleMatchTeam.map(pmt => pmt.team));

      const complete_poule: CompletePoule = {
        id: id_param,
        name: poule.name,
        teams: poule_teams,
        matches: `/poules/${poule.id}/matches`,
      };

      reply.send(complete_poule);
    });
    instance.get("/poules/:pouleId/matches", async (request: any, reply) => {
      // Check if poule exists
      const poule = await prisma.poule.findFirst({
        where: {
          id: parseInt(request.params.pouleId),
        },
      });
      if (!poule) {
        reply.code(404).send();
        return;
      }

      // Get list of matches
      const pouleMatches = await prisma.pouleMatch.findMany({
        where: {
          pouleId: parseInt(request.params.pouleId),
        },
        include: {
          PouleMatchTeam: {
            include: {
              team: {
                select: {
                  id: true,
                  name: true,
                  league: true,
                },
              },
            },
            orderBy: {
              id: "asc",
            },
          },
        },
        orderBy: {
          id: "asc",
        },
      });

      const pouleMatchesFormatted = pouleMatches.map(pm => {
        return {
          id: pm.id,
          date: pm.date,
          teams: pm.PouleMatchTeam.map(pmt => {
            return {
              id: pmt.team.id,
              name: pmt.team.name,
              score: pmt.score,
              league: pmt.team.league,
            };
          }),
        };
      });

      reply.send(pouleMatchesFormatted);
    });

    instance.get<{ Querystring: { count: string; league: string } }>("/poules/matches", async (req, res) => {
      const count = parseInt(req.query.count);
      if (!count) {
        return res.status(200).send([]);
      }

      const matches = await prisma.pouleMatch.findMany({
        where: {
          AND: {
            NOT: {
              date: null,
            },
            poule: {
              league: req.query.league,
            },
          },
        },
        include: {
          PouleMatchTeam: {
            include: {
              team: true,
            },
          },
        },
        orderBy: {
          date: "desc",
        },
        take: count,
      });

      return matches.map(
        (
          match: PouleMatch & {
            teams?: (Team & { score: number | null })[];
            PouleMatchTeam?: (PouleMatchTeam & { team: Team })[];
          }
        ) => {
          match.teams = match.PouleMatchTeam?.map(pmt => ({ ...pmt.team, score: pmt.score })) ?? [];
          delete match.PouleMatchTeam;
          return match;
        }
      );
    });

    instance.get("/poules/:pouleId/matches/:matchId", async (request: any, reply) => {
      // Check if match exists in poule
      const pouleMatch = await prisma.pouleMatch.findFirst({
        where: {
          id: parseInt(request.params.matchId),
          pouleId: parseInt(request.params.pouleId),
        },
        include: {
          PouleMatchTeam: {
            include: {
              team: {
                select: {
                  id: true,
                  name: true,
                  league: true,
                },
              },
            },
          },
        },
      });
      if (!pouleMatch) {
        reply.code(404).send();
        return;
      }

      const pouleMatchFormatted = {
        id: pouleMatch.id,
        date: pouleMatch.date,
        teams: pouleMatch.PouleMatchTeam.map(pmt => {
          return {
            id: pmt.team.id,
            name: pmt.team.name,
            score: pmt.score,
            league: pmt.team.league,
          };
        }),
      };

      reply.send(pouleMatchFormatted);
    });
    instance.get<{ Params: { league: string } }>("/bracket/:league/matches", async (request, reply) => {
      const bracketMatches = await prisma.bracketMatch.findMany({
        where: {
          league: request.params.league,
        },
        include: {
          BracketMatchTeam: {
            include: {
              team: true,
            },
          },
        },
      });
      if (bracketMatches.length === 0) {
        return reply.status(404).send({ message: "Er bestaat geen bracket voor deze league" });
      }

      bracketMatches.sort((m1, m2) => {
        if (m1.parentId === null) return -1;
        if (m2.parentId === null) return 1;
        return m2.parentId - m1.parentId;
      });

      const strippedMatches = bracketMatches.map(bm => {
        const match: Omit<BracketMatch, "BracketMatchTeam"> & { teams: TeamWScore[] } = {
          ...bm,
          teams: bm.BracketMatchTeam.map(bmt => ({ score: bmt.score ?? 0, ...bmt.team })),
        };
        // @ts-ignore
        delete match.BracketMatchTeam;
        return match
      });

      // Make frontend life easier
      const bracketTree: Brackets.MatchNode[][] = createBracketTree(strippedMatches);
      return reply.status(200).send(bracketTree[0]);

      // move tree to 2d array
      // const rounds: BracketMatch[][] = [];
      // const treeFlattener = (tree: Brackets.MatchNode[], roundIdx = 0) => {
      //   tree.forEach(match => {
      //     if (match.children) {
      //       treeFlattener(match.children, roundIdx + 1);
      //     }
      //     if (!rounds[roundIdx]) {
      //       rounds[roundIdx] = [];
      //     }
      //     match.teams = match.BracketMatchTeam;
      //     delete match.children;
      //     delete match.BracketMatchTeam;
      //     rounds[roundIdx].push(match);
      //   });
      // };
      // treeFlattener(bracketTree);
      // return reply.status(200).send(rounds.reverse());
    });

    // POST requests
    instance.post("/teams", async (request: any, reply) => {
      // Create a new team
      const team = await prisma.team.create({
        data: {
          name: request.body.name,
          league: request.body.league,
        },
      });
      reply.send(team);
    });
    instance.post<{ Body: { name: string; league: string; teams: number[] } }>("/poules", async (request, reply) => {
      // Check if at least 2 teams are given
      if (request.body.teams.length < 2) {
        reply.status(400).send({ message: "At least 2 teams are required." });
        return;
      }

      // Checking if teams exist
      for (const teamId of request.body.teams) {
        const exists = !!(await prisma.team.findFirst({
          where: {
            id: teamId,
          },
        }));
        if (!exists) {
          reply.status(400).send({ message: `Team with id ${teamId} does not exists.` });
          return;
        }
        const alreadyAssigned = await prisma.pouleMatchTeam.findFirst({
          where: {
            teamId,
          },
        });
        if (alreadyAssigned) {
          reply.status(400).send({ message: `Team with id ${teamId} is already assigned to another pool.` });
          return;
        }
      }

      // Create a new poule
      const poule = await prisma.poule.create({
        data: {
          name: request.body.name,
          league: request.body.league,
        },
      });

      const result = await createPouleMatches(prisma, request.body.teams, poule);
      reply.send(result);
    });

    instance.post("/bracket", async (request: any, reply) => {
      const amount: number = request.body.amount;
      const league: string = request.body.league;

      if (league.length === 0) {
        reply.status(400).send({ message: "league should not be empty" });
        return;
      }

      const bracketMatchForLeague = await prisma.bracketMatch.findFirst({
        where: {
          league,
        },
      });

      if (bracketMatchForLeague) {
        reply.status(400).send({ message: "league already has a bracket" });
        return;
      }

      if (2 ** Math.round(Math.log2(amount)) !== amount) {
        reply.status(400).send({ message: "amount should be a power of 2" });
        return;
      }

      const initializeBracketRecursive = async (n: number, parent: null | BracketMatch) => {
        if (n === 1) {
          // End recursion.
        } else if (n === 2) {
          await prisma.bracketMatch.create({
            data: {
              parentId: parent === null ? null : parent.id,
              league,
              date: null,
            },
          });
        } else {
          const new_parent = await prisma.bracketMatch.create({
            data: {
              parentId: parent === null ? null : parent.id,
              league,
              date: null,
            },
          });
          const half = n / 2;
          await initializeBracketRecursive(half, new_parent);
          await initializeBracketRecursive(half, new_parent);
        }
      };

      await initializeBracketRecursive(amount, null);
      reply.send({ message: "created" });
    });

    // PATCH requests
    instance.patch("/teams/:teamId", async (request: any, reply) => {
      // Update a team's name and/or league (league only if team not used in a poule yet)
      if (request.body.league !== undefined) {
        const teamIsUsed = !!(await prisma.pouleMatchTeam.findFirst({
          where: {
            teamId: parseInt(request.params.teamId),
          },
        }));
        if (teamIsUsed) {
          reply.status(400).send({ message: "Team is already used in a poule." });
          return;
        }
      }

      const data: any = {};
      if (request.body.name !== undefined) {
        data["name"] = request.body.name;
      }
      if (request.body.league !== undefined) {
        data["league"] = request.body.league;
      }

      // Update a team's name and/or league
      const team = await prisma.team.update({
        where: {
          id: parseInt(request.params.teamId),
        },
        data: data,
      });

      reply.send(team);
    });
    instance.patch("/poules/:id", async (request: any, reply) => {
      // Check that poule exists
      let poule = await prisma.poule.findFirst({
        where: {
          id: parseInt(request.params.id),
        },
      });
      const pouleExists = !!poule;
      if (!pouleExists) {
        reply.status(400).send({ message: "Poule does not exist." });
        return;
      }

      // If name is given, update poule name
      if (request.body.name !== undefined) {
        poule = await prisma.poule.update({
          where: {
            id: parseInt(request.params.id),
          },
          data: {
            name: request.body.name,
          },
        });
      }

      // If teams are given, update poule teams
      if (request.body.teams !== undefined) {
        // Check if at least 2 teams are given
        if (request.body.teams.length < 2) {
          reply.status(400).send({ message: "At least 2 teams are required." });
          return;
        }

        // Checking if teams exist
        for (const teamId of request.body.teams) {
          const exists = !!(await prisma.team.findFirst({
            where: {
              id: teamId,
            },
          }));
          if (!exists) {
            reply.status(400).send({ message: `Team with id ${teamId} does not exists.` });
            return;
          }
        }

        // Check if matches have already been played (score !== null)
        const illegalToDelete = await matchesHaveBeenPlayed(prisma, parseInt(request.params.id));
        if (illegalToDelete) {
          reply.status(400).send({ message: "Matches have already been played." });
          return;
        }

        // Delete all poule matches and teams
        await deletePouleMatchesAndTeams(prisma, parseInt(request.params.id));

        // Create new poule matches
        const result = await createPouleMatches(prisma, request.body.teams, poule);
        reply.send(result);
        return;
      }
      reply.send(poule);
    });
    instance.patch<{
      Body: { date: string; scores: Record<number, number> };
      Params: { matchId: string; pouleId: string };
    }>("/poules/:pouleId/matches/:matchId", async (request, reply) => {
      if (request.body.date === undefined) {
        return reply.status(400).send({
          message: `The body is missing a date when the match was finished/played/registered`,
        });
      }
      // Check if matchId belongs to pouleId
      let pouleMatch = await prisma.pouleMatch.findFirst({
        where: {
          id: parseInt(request.params.matchId),
          pouleId: parseInt(request.params.pouleId),
        },
      });
      if (!pouleMatch) {
        reply.status(400).send({
          message: `Match with id ${request.params.matchId} not found in poule ${request.params.pouleId}.`,
        });
        return;
      }

      pouleMatch = await prisma.pouleMatch.update({
        where: {
          id: parseInt(request.params.matchId),
        },
        data: {
          date: new Date(request.body.date),
        },
      });

      for (const teamId in request.body.scores) {
        const pouleMatchTeam = await prisma.pouleMatchTeam.findFirst({
          where: {
            teamId: parseInt(teamId),
            pouleMatchId: parseInt(request.params.matchId),
          },
        });
        if (!pouleMatchTeam) {
          return reply.status(400).send({
            message: `${teamId} is not a player in the match ${request.params.matchId} in pool ${request.params.pouleId}`,
          });
        }
        await prisma.pouleMatchTeam.update({
          where: {
            id: parseInt(teamId),
          },
          data: {
            score: request.body.scores[Number(teamId)],
          },
        });
      }

      reply.send(pouleMatch);
    });
    instance.patch("/poules/:pouleId/matches/:matchId/teams/:teamId", async (request: any, reply) => {
      // Check if matchId belongs to pouleMatchId and pouleId
      let pouleMatchTeam = await prisma.pouleMatchTeam.findFirst({
        where: {
          pouleMatchId: parseInt(request.params.matchId),
          teamId: parseInt(request.params.teamId),
          pouleMatch: {
            pouleId: parseInt(request.params.pouleId),
          },
        },
      });
      if (!pouleMatchTeam) {
        reply.status(400).send({
          message: `Team with id ${request.params.teamId} not found in match ${request.params.matchId} in poule ${request.params.pouleId}.`,
        });
        return;
      }

      // Check if score is given
      if (request.body.score !== undefined) {
        pouleMatchTeam = await prisma.pouleMatchTeam.update({
          where: {
            id: pouleMatchTeam.id,
          },
          data: {
            score: request.body.score,
          },
        });
      }
      reply.send(pouleMatchTeam);
    });
    instance.patch("/bracket/matches/:matchId", async (request, reply) => {
      // TODO: implement
    });
    instance.patch("/bracket/matches/:matchId/teams/:teamId", async (request: any, reply) => {
      // Check if matchId belongs to teamId
      let bracketMatchTeam = await prisma.bracketMatchTeam.findFirst({
        where: {
          bracketMatchId: parseInt(request.params.matchId),
          teamId: parseInt(request.params.teamId),
        },
      });
      if (!bracketMatchTeam) {
        reply.status(400).send({
          message: `Team with id ${request.params.teamId} not found in match ${request.params.matchId}.`,
        });
        return;
      }

      // Check if score is given
      if (request.body.score !== undefined) {
        bracketMatchTeam = await prisma.bracketMatchTeam.update({
          where: {
            id: bracketMatchTeam.id,
          },
          data: {
            score: request.body.score,
          },
        });
      }
      reply.send(bracketMatchTeam);
    });

    // DELETE requests
    instance.delete("/teams/:teamId", async (request: any, reply) => {
      // Only delete if no poule matches are using this team
      const teamIsUsed = !!(await prisma.pouleMatchTeam.findFirst({
        where: {
          teamId: parseInt(request.params.teamId),
        },
      }));
      if (teamIsUsed) {
        reply.status(400).send({ message: "Team is already used in a poule match." });
        return;
      }

      // Delete a team with id = teamId
      await prisma.team.delete({
        where: {
          id: parseInt(request.params.teamId),
        },
      });

      reply.status(200);
    });
    instance.delete("/poules/:pouleId", async (request: any, reply) => {
      // Check that poule exists
      const poule = await prisma.poule.findFirst({
        where: {
          id: parseInt(request.params.pouleId),
        },
      });
      const pouleExists = !!poule;
      if (!pouleExists) {
        return;
      }

      // Check if matches have already been played (score !== null)
      const illegalToDelete = await matchesHaveBeenPlayed(prisma, poule.id);
      if (illegalToDelete) {
        reply.status(400).send({ message: "Matches have already been played." });
        return;
      }

      // Delete all poule matches and teams
      await deletePouleMatchesAndTeams(prisma, poule.id);

      // Delete poule
      await prisma.poule.delete({
        where: {
          id: poule.id,
        },
      });

      reply.status(200);
    });

    next();
  },
  { prefix: "/api" }
);

server.get("*", (_, res) => {
  res.sendFile("index.html");
});

server.listen({ host: "0.0.0.0", port: 8080 }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
