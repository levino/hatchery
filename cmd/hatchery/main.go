package main

import (
	"context"
	"fmt"
	"os"

	"github.com/levinkeller/hatchery/internal/config"
	"github.com/levinkeller/hatchery/internal/drone"
	"github.com/levinkeller/hatchery/internal/zerg"
	"github.com/spf13/cobra"
)

func main() {
	root := &cobra.Command{
		Use:   "hatchery",
		Short: "Manage devcontainer drones on the Hetzner hive",
	}

	root.AddCommand(spawnCmd(), listCmd(), statusCmd(), burrowCmd(), unburrowCmd(), slayCmd())

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func spawnCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "spawn <org/repo>",
		Short: "Spawn a new drone from a GitHub repository",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			cli, err := drone.NewClient()
			if err != nil {
				return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
			}
			defer cli.Close()

			return drone.Spawn(cmd.Context(), cli, drone.SpawnOptions{
				Repo:   args[0],
				Config: cfg,
			})
		},
	}
}

func listCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all drones in the hive",
		RunE: func(cmd *cobra.Command, args []string) error {
			cli, err := drone.NewClient()
			if err != nil {
				return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
			}
			defer cli.Close()

			drones, err := drone.ListDrones(cmd.Context(), cli)
			if err != nil {
				return err
			}
			if len(drones) == 0 {
				zerg.Printf(zerg.MsgNoDrones)
				return nil
			}
			for _, d := range drones {
				fmt.Println(zerg.Status(d.Name, d.State))
			}
			return nil
		},
	}
}

func statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <org/repo>",
		Short: "Show status of a specific drone",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cli, err := drone.NewClient()
			if err != nil {
				return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
			}
			defer cli.Close()

			name := drone.DroneName(args[0])
			d, err := drone.FindDrone(cmd.Context(), cli, name)
			if err != nil {
				return err
			}
			if d == nil {
				return fmt.Errorf(zerg.MsgDroneNotFound)
			}

			fmt.Println(zerg.Status(d.Name, d.State))
			fmt.Printf("  Repo:      %s\n", d.Repo)
			fmt.Printf("  Container: %s\n", d.ID[:12])
			return nil
		},
	}
}

func burrowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "burrow <org/repo>",
		Short: "Stop a drone (burrow underground)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cli, err := drone.NewClient()
			if err != nil {
				return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
			}
			defer cli.Close()

			name := drone.DroneName(args[0])
			d, err := drone.FindDrone(cmd.Context(), cli, name)
			if err != nil {
				return err
			}
			if d == nil {
				return fmt.Errorf(zerg.MsgDroneNotFound)
			}

			if err := drone.StopDrone(cmd.Context(), cli, d.ID); err != nil {
				return err
			}
			zerg.Printf(zerg.MsgBurrowComplete)
			return nil
		},
	}
}

func unburrowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unburrow <org/repo>",
		Short: "Start a stopped drone (emerge from the ground)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cli, err := drone.NewClient()
			if err != nil {
				return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
			}
			defer cli.Close()

			name := drone.DroneName(args[0])
			d, err := drone.FindDrone(cmd.Context(), cli, name)
			if err != nil {
				return err
			}
			if d == nil {
				return fmt.Errorf(zerg.MsgDroneNotFound)
			}

			if err := drone.StartDrone(cmd.Context(), cli, d.ID); err != nil {
				return err
			}
			zerg.Printf(zerg.MsgUnburrowComplete)
			return nil
		},
	}
}

func slayCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "slay <org/repo>",
		Short: "Remove a drone permanently",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cli, err := drone.NewClient()
			if err != nil {
				return fmt.Errorf("%s %w", zerg.MsgDockerError, err)
			}
			defer cli.Close()

			ctx := context.Background()
			name := drone.DroneName(args[0])
			d, err := drone.FindDrone(ctx, cli, name)
			if err != nil {
				return err
			}
			if d == nil {
				return fmt.Errorf(zerg.MsgDroneNotFound)
			}

			if err := drone.RemoveDrone(ctx, cli, d.ID); err != nil {
				return err
			}

			// Clean up the volume
			volName := drone.VolumeName(name)
			_ = cli.VolumeRemove(ctx, volName, true)

			zerg.Printf(zerg.MsgSlayComplete)
			return nil
		},
	}
}
